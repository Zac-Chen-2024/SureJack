import type { FastifyInstance } from 'fastify'
import { readFile, rm } from 'node:fs/promises'
import { openUserDb } from '../db/user-db.js'
import { adoptSrtText, overrunWarning, scriptFromSrtWords } from '../subtitles/from-srt.js'
import { clampSubtitleMarginV } from '../subtitles/project-ass.js'
import { probeDurationMs } from '../render/probe.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { openLibraryDb } from '../library/library-db.js'
import { hasVideoMaterials, planProjectBackground } from '../library/background.js'
import { bgTrackInfo, type PrebuildDeps } from '../compose/prebuild.js'
import { enqueueFilm } from '../compose/film.js'

type Deps = PrebuildDeps

/**
 * 项目 CRUD。
 *
 * ⚠️ 每个 handler 都用会话身份打开【那个人自己的库】——
 * openUserDb(name, whitelist) 只收姓名，路径由白名单映射唯一确定。
 * 所以这里没有、也不需要任何 `WHERE owner = ?`：
 * 打开的库本身就是那个人的，跨用户读取在结构上不可能发生。
 *
 * 每次请求开库/关库：SQLite 打开极快（微秒级），2 用户场景下
 * 比维护连接池简单得多，且天然避免了"连接绑错用户"这类 bug。
 */
export function registerProjectRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, libraryDataDir } = deps

  /** 用当前会话身份开库，跑一段逻辑，然后必定关库 */
  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const name = getSession(req)!
    return withUserDb(name, (db) => db.listProjects())
  })

  app.post<{ Body: { name?: unknown } }>('/api/projects', { preHandler: requireAuth }, async (req, reply) => {
    const projectName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!projectName) return reply.code(400).send({ error: '请填项目名' })
    const name = getSession(req)!
    return withUserDb(name, (db) => db.createProject(projectName))
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const project = withUserDb(name, (db) => db.getProject(req.params.id))
    if (!project) return reply.code(404).send({ error: '项目不存在' })
    return project
  })

  app.patch<{ Params: { id: string }; Body: {
    name?: unknown; scriptText?: unknown; aspectRatio?: unknown
    bgmLibraryId?: unknown; bgmVolume?: unknown; subtitleMarginV?: unknown
  } }>(
    '/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
      const patch: {
        name?: string; scriptText?: string; aspectRatio?: string
        bgmLibraryId?: string | null; bgmVolume?: number; subtitleMarginV?: number
      } = {}
      if (typeof req.body?.name === 'string') patch.name = req.body.name
      if (typeof req.body?.scriptText === 'string') patch.scriptText = req.body.scriptText
      if (typeof req.body?.aspectRatio === 'string') patch.aspectRatio = req.body.aspectRatio
      /*
       * bgmLibraryId 的 null 是【有意义的值】——"不要 BGM"。所以不能像上面
       * 几个字段那样只认字符串就完事：null 必须原样传下去清库，而其余类型
       * （数字、对象……）一律忽略，不让脏值落库。
       */
      const bgm = req.body?.bgmLibraryId
      if (typeof bgm === 'string' || bgm === null) patch.bgmLibraryId = bgm

      /*
       * bgmVolume：背景音乐相对配音的音量，0..1（导出时经 buildAudioFilter
       * 生效）。**必须钳位**——它会原样进 ffmpeg 的 volume 滤镜，
       * 一个 100 会把整条音轨削爆。NaN/Infinity 也要挡在库外。
       */
      const vol = req.body?.bgmVolume
      if (typeof vol === 'number' && Number.isFinite(vol)) {
        patch.bgmVolume = Math.min(1, Math.max(0, vol))
      }

      const name = getSession(req)!
      const updated = withUserDb(name, (db) => {
        const before = db.getProject(req.params.id)
        if (!before) return null

        /*
         * subtitleMarginV：字幕距底边的像素数，直接进 ASS 样式行。
         *
         * 【必须钳到 0..画面高度的一半】——libass 对越界值照单全收，字幕会
         * 渲染到画外，用户只看到"字幕没了"，完全不可自证。前端滑块的
         * min/max 只是体验，接口是公开的，防线在这里。
         *
         * 上界跟着【这次请求之后】的画幅走：同一个 PATCH 里可以既换画幅
         * 又调高度，按旧画幅钳会算错。
         */
        const aspect = patch.aspectRatio ?? before.aspectRatio
        const raw = req.body?.subtitleMarginV
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          patch.subtitleMarginV = clampSubtitleMarginV(raw, aspect)
        } else if (patch.aspectRatio !== undefined) {
          /*
           * 只换画幅、没传高度：存着的旧值可能已经超过新画面的一半
           * （9:16 的 900 放到 16:9 上就出画了）。用户只是换了个画幅，
           * 字幕不该凭空消失，所以顺手把它重新钳进新范围。
           */
          patch.subtitleMarginV = clampSubtitleMarginV(before.subtitleMarginV, aspect)
        }

        return db.updateProject(req.params.id, patch)
      })
      if (!updated) return reply.code(404).send({ error: '项目不存在' })
      return updated
    })

  /**
   * 这个项目的背景轨排布：开头 → 常规 → 地铁跑酷，与配音精确等长。
   *
   * 只读、每次现算，**不落库**——项目只存素材 id 引用，绝不复制素材
   * （地铁跑酷单桶就 4.7GB）。前端拿它画预览条，导出时用同一个函数
   * 算出同一份排布，所见即所得。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/background-plan', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const lib = openLibraryDb(libraryDataDir)
      try {
        /*
         * 配音未就绪是正常中间态，planProjectBackground 自己回空排布。
         * 但【素材库一条视频都没有】是另一回事——库还没扫过，是个能靠
         * POST /api/library/scan 解决的状态问题。不先判这一下的话，
         * planBackground 会抛错、落到全局错误处理器变成 500「服务器内部
         * 错误」，可操作的原因全被抹掉。用 409 明确说出来。
         */
        if (project.ttsDurationMs !== null && project.ttsDurationMs > 0 && !hasVideoMaterials(lib)) {
          return reply.code(409).send({ error: '素材库里没有可用的视频素材，请先扫描素材库' })
        }
        return planProjectBackground(lib, project.id, project.ttsDurationMs)
      } finally {
        lib.close()
      }
    })

  /**
   * 采用自备的配音 + 字幕：把上传的 SRT 变成项目的时间轴。
   *
   * 【为什么是显式接口，而不是上传完 srt 自动触发】：配音和字幕是**两个
   * 文件**，到达顺序不定。挂在 srt 上传上的话，先传字幕后传配音就永远
   * 派生不了；挂在两个上传上各判一次，则同一段逻辑要写两遍、还要处理
   * 并发到达。做成一个显式的、幂等的接口最简单：前端两个都传完调一次，
   * 用户重试就再调一次，前置条件不满足时给的是【能照着做的】提示。
   *
   * 这一步之后**下游全部零改动**：字幕派生、预览、背景排布、导出都只认
   * wordTimingsJson + ttsDurationMs，不关心它们是 Azure 生成的还是传的。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/adopt-srt', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const assets = withUserDb(name, (db) => db.listAssets(req.params.id))
      const srtAsset = assets.find((a) => a.kind === 'srt')
      const voiceAsset = assets.find((a) => a.kind === 'voice')

      // 前置校验给的是【可操作的】话，不是笼统的「参数错误」
      if (!srtAsset && !voiceAsset) {
        return reply.code(400).send({ error: '还差配音文件和字幕文件，把 mp3 和 srt 一起拖进来' })
      }
      if (!voiceAsset) return reply.code(400).send({ error: '还差配音文件（mp3 / wav / m4a / aac）' })
      if (!srtAsset) return reply.code(400).send({ error: '还差字幕文件（.srt）' })

      let text: string
      try {
        text = await readFile(srtAsset.path, 'utf8')
      } catch {
        return reply.code(400).send({ error: '字幕文件已丢失，请重新上传' })
      }

      const { words, cueCount, lastEndMs } = adoptSrtText(text)
      if (cueCount === 0) {
        return reply.code(400).send({ error: '字幕文件解析不出内容，确认是标准 SRT 格式' })
      }

      /*
       * 成片时长跟【配音】走，不是最后一条 cue 的结束时间：尾部往往有
       * 自然静音，用字幕结尾会把配音掐断。probeDurationMs 已经 Math.round
       * 成整数毫秒——小数毫秒会让背景排布直接 500，别在这里再引入新的小数源。
       */
      let durationMs: number
      try {
        durationMs = await probeDurationMs(voiceAsset.path)
      } catch {
        return reply.code(400).send({ error: '配音文件无法解码，可能已损坏，请重新上传' })
      }

      /*
       * 文案回填：文案是项目的一等公民，自备路径下没有它这条视频在列表里
       * 就"没有内容"。
       * ⚠️ **只在文案为空时填**。用户可能先写了文案再传字幕，静默覆盖是
       * 不可逆的数据丢失。已有文案时原样保留，并在响应里说明没有回填。
       */
      const hasScript = project.scriptText.trim().length > 0
      const scriptText = hasScript ? undefined : scriptFromSrtWords(words)

      withUserDb(name, (db) => db.updateProject(req.params.id, {
        ttsState: 'ready',
        ttsDurationMs: durationMs,
        wordTimingsJson: JSON.stringify(words),
        // 自备 SRT 是句级时间戳，做不了逐字扫光——整句显示
        subtitleMode: 'line',
        ...(scriptText === undefined ? {} : { scriptText }),
      }))

      /*
       * 自备配音这条路和 Azure 那条一样，到这里就"配音就绪"了——
       * 背景轨和成片都该开始做了。不 await、失败不影响这次派生
       * （见 tts/routes.ts 里同一段注释）。
       */
      void enqueueFilm(deps, name, req.params.id)
        .catch((e: unknown) => { req.log.warn({ err: e }, '成片自动合成入队失败，稍后由状态接口补排') })

      return {
        cueCount,
        durationMs,
        subtitleMode: 'line' as const,
        /** 是否把 SRT 正文回填进了文案区。false 表示原有文案被保留了 */
        scriptFilled: !hasScript,
        warning: overrunWarning(lastEndMs, durationMs),
      }
    })

  /**
   * 背景轨现在什么情况。**预览专用**。
   *
   * 四种状态各自对应界面上一句不同的话，别合并（见 web 的 bgTrackNotice）：
   * ready 直接播；building 说"生成中"；error 要说清【导出时会重新生成】，
   * 不能让预览的失败看起来像导出会失败——那是两回事，吓人还没必要。
   *
   * 这个接口【会顺手补拼】：老项目的配音是上线前生成的，没触发过预拼，
   * 前端问一次状态就把它排上，用户不必知道内部规矩。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/bg-track', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return bgTrackInfo(deps, name, req.params.id)
    })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const ok = withUserDb(name, (db) => db.deleteProject(req.params.id))
    if (!ok) return reply.code(404).send({ error: '项目不存在' })

    /*
     * 【文件也要一起删】。DB 那边靠 ON DELETE CASCADE 干净了，盘上不会。
     *
     * 背景轨约 65MB/分钟——一条 11.5 分钟的片子光这一条轨就 750MB，
     * 而它现在是【常驻】的（预览随时要播）。删项目不删文件的话，
     * 磁盘只涨不落，当前可用空间大概撑三条。
     *
     * 目录由 assetDir 从会话身份拼出（先过白名单、projectId 只允许
     * UUID 字符），不接受任何外部路径——删除是不可逆操作，这一点尤其
     * 不能松。删失败只记日志：记录已经没了，那才是真相。
     */
    try {
      await rm(assetDir(name, whitelist, req.params.id), { recursive: true, force: true })
    } catch (e) {
      req.log.warn({ err: e }, '项目文件目录没清干净，磁盘会留下残留')
    }
    return { ok: true }
  })
}
