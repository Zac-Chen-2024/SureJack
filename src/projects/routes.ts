import type { FastifyInstance } from 'fastify'
import { readFile, rm } from 'node:fs/promises'
import { openUserDb } from '../db/user-db.js'
import { adoptSrtText, overrunWarning, scriptFromSrtWords } from '../subtitles/from-srt.js'
import { clampSubtitleFontSize, clampSubtitleMarginV } from '../subtitles/project-ass.js'
import { isAllowedVoice, clampRate, clampVolume, clampPitch } from '../tts/voices.js'
import { probeDurationMs } from '../render/probe.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { openLibraryDb } from '../library/library-db.js'
import {
  hasVideoMaterials, planProjectBackground, parseOpeningPick, openingIdsOf, OPENING_BUCKET, rng, seedFrom, shuffled,
} from '../library/background.js'
import { listBucket } from '../library/scan.js'
import { bgTrackInfo, type PrebuildDeps } from '../compose/prebuild.js'
import { enqueueFilm } from '../compose/film.js'
import { ensureAudioStats } from '../audio/routes.js'
import { downloadPrep } from '../compose/download-queue.js'
import { parseLayoutRatio } from '../compose/plan.js'
import { fillToTarget } from '../library/auto-fill.js'

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

  /**
   * 某个项目【现在事实上用的】开头素材 id。
   * 挑过就是挑的那份；没挑过（还停在默认）就把默认排布算出来。
   * 给续集剔重用——续集要避开的是主片真正在用的那几段。
   */
  function openingOf (
    lib: ReturnType<typeof openLibraryDb>, userName: string, projectId: string,
  ): string[] {
    const p = withUserDb(userName, (db) => db.getProject(projectId))
    if (p === null) return []
    const picked = parseOpeningPick(p.openingPickJson)
    if (picked.length > 0) return picked
    return openingIdsOf(planProjectBackground(lib, p.id, p.ttsDurationMs, {
      sequel: p.parentProjectId !== null,
      headBoundaryMs: p.headBoundaryMs,
      layoutRatio: parseLayoutRatio(p.layoutRatioJson),
    }))
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
    bgmLibraryId?: unknown; bgmVolume?: unknown; voiceGain?: unknown; voiceDraftJson?: unknown
    subtitleMarginV?: unknown; subtitleFontSize?: unknown
    voiceName?: unknown; voiceRate?: unknown; voiceVolume?: unknown; voicePitch?: unknown
    coverTitle?: unknown; inVideoTitle?: unknown; watermarkText?: unknown
  } }>(
    '/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
      const patch: {
        name?: string; scriptText?: string; aspectRatio?: string
        bgmLibraryId?: string | null; bgmVolume?: number; voiceGain?: number
        voiceDraftJson?: string
        subtitleMarginV?: number; subtitleFontSize?: number
        voiceName?: string; voiceRate?: number; voiceVolume?: number; voicePitch?: number
        coverTitle?: string; inVideoTitle?: string; watermarkText?: string
      } = {}
      if (typeof req.body?.name === 'string') patch.name = req.body.name
      if (typeof req.body?.scriptText === 'string') patch.scriptText = req.body.scriptText
      if (typeof req.body?.aspectRatio === 'string') patch.aspectRatio = req.body.aspectRatio
      /*
       * 封面标题。空串是【有意义的值】——"跟着项目名走"，所以不过滤空。
       * 截到 20 个字：再长的标题在 1080 宽的画面上会挤成一条看不清的线，
       * 而 drawtext 不会自动换行（它只会把字画到画外去）。
       */
      if (typeof req.body?.coverTitle === 'string') {
        patch.coverTitle = req.body.coverTitle.trim().slice(0, 20)
      }
      // 片内标题同理。它渲染在顶部一行里，太长会顶到画面外
      if (typeof req.body?.inVideoTitle === 'string') {
        patch.inVideoTitle = req.body.inVideoTitle.trim().slice(0, 20)
      }
      /*
       * 水印文字。空串同样是【有意义的值】——"不打水印"，是所有老项目的现状。
       * 截到 8 个字：水印是贴边走的，字一多就会横穿画面，
       * 而它在竖屏两侧的位置本来就只有百来像素的余地。
       */
      if (typeof req.body?.watermarkText === 'string') {
        patch.watermarkText = req.body.watermarkText.trim().slice(0, 8)
      }
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

      /*
       * voiceGain：配音在混音时的增益。
       *
       * ⚠️ 和 voiceVolume 不是一回事：那个是 Azure 合成参数（改了要重新
       * 合成、重新计费），这个只是混音增益（改了几秒重混）。
       * 同样【必须钳位】——它原样进 ffmpeg 的 volume 滤镜。
       * 上界 4（+12dB）：再高就是把噪底一起放大，而归一化那步本来就会
       * 把整体推到平台基准，用不着靠它硬顶。
       */
      /*
       * voiceDraftJson：配音参数的草稿。存的是【还没确认】的那组值，
       * 不进指纹、不影响任何产物——它只保证"下次进来还是我上次调的"。
       * 空串 = 清掉草稿（确认之后调用方会这么做）。
       */
      const vd = req.body?.voiceDraftJson
      if (typeof vd === 'string') patch.voiceDraftJson = vd.slice(0, 2000)

      const vg = req.body?.voiceGain
      if (typeof vg === 'number' && Number.isFinite(vg)) {
        patch.voiceGain = Math.min(4, Math.max(0.1, vg))
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

  /*
   * 字号和 marginV 同样【必须钳】：滑块给不出越界值，但接口是公共入口，
   * 一个 5000 号字会让每句话折成十几行，字幕糊满整个画面。
   */
  {
    const raw = req.body?.subtitleFontSize
    if (raw !== undefined) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return reply.code(400).send({ error: '字幕字号格式错误' })
      }
      patch.subtitleFontSize = clampSubtitleFontSize(raw)
    }
        }

        /*
         * 配音参数。音色走【枚举白名单】——不在清单里的 id 到了 Azure 会
         * 直接合成失败，早挡早好；语速/音量/音调【钳位】到合法范围。
         */
        if (req.body?.voiceName !== undefined) {
          if (!isAllowedVoice(req.body.voiceName)) {
            return reply.code(400).send({ error: '不支持的音色' })
          }
          patch.voiceName = req.body.voiceName
        }
        if (req.body?.voiceRate !== undefined) patch.voiceRate = clampRate(req.body.voiceRate)
        if (req.body?.voiceVolume !== undefined) patch.voiceVolume = clampVolume(req.body.voiceVolume)
        if (req.body?.voicePitch !== undefined) patch.voicePitch = clampPitch(req.body.voicePitch)

        return db.updateProject(req.params.id, patch)
      })
      if (!updated) return reply.code(404).send({ error: '项目不存在' })

      /*
       * 【预加载】换了背景音乐就顺手把它的波形和响度量出来。
       * 不 await——用户点"选这首"不该为了画一条波形多等几秒；
       * 等他滑到音频那一栏时，多半已经算完了。
       */
      /*
       * 【音量/音乐一改，就把备好的那份作废】。不作废的话，用户刚拖完滑块
       * 点下载，拿到的还是上一份——而他要验的正是这次的改动。
       */
      if (patch.voiceGain !== undefined || patch.bgmVolume !== undefined
        || patch.bgmLibraryId !== undefined) {
        downloadPrep.invalidate(req.params.id)
      }

      if (patch.bgmLibraryId !== undefined) {
        void ensureAudioStats(name, deps.whitelist, req.params.id, deps.libraryDataDir)
          .catch(() => { /* 音频面板那边会再试一次 */ })
      }
      return updated
    })

  /**
   * 这个项目的背景轨排布：开头 → 常规 → 地铁跑酷，与配音精确等长。
   *
   * 只读、每次现算，**不落库**——项目只存素材 id 引用，绝不复制素材
   * （地铁跑酷单桶就 4.7GB）。前端拿它画预览条，导出时用同一个函数
   * 算出同一份排布，所见即所得。
   */
  /**
   * 「我动过这条项目了」。归档扫描按它算"多久没动"。
   *
   * ⚠️【必须和 updatedAt 分开】：updatedAt 只在改了内容时才动，而"打开看了
   * 一眼""播放了一下"也算动过。按 updatedAt 算的话，天天在看但没改过的
   * 片子会被收起来——那是帮倒忙。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/touch', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const ok = withUserDb(name, (db) =>
        db.updateProject(req.params.id, { touchedAt: new Date().toISOString() }))
      if (!ok) return reply.code(404).send({ error: '项目不存在' })
      return { ok: true }
    })

  /**
   * 复原一条归档的项目：重拼背景轨 + 重烧母带。
   *
   * 【为什么是"无损"】：归档只删可重算的东西（背景轨、母带、预览分段）。
   * 背景排布在敲定开头时就【物化成一份具体清单】存进库了，字幕从库里的
   * 词级时间戳推，配音文件原样留着——所以复原出来的片子和原来逐帧一致。
   * 要是排布还是"拿项目 id 现算"，素材库一变就复原不出原样了。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/restore', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const p = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!p) return reply.code(404).send({ error: '项目不存在' })
      withUserDb(name, (db) => db.updateProject(req.params.id, {
        archivedAt: '', touchedAt: new Date().toISOString(),
      }))
      /*
       * 清掉归档标记之后照常入队：正常路径发现母带不在，自然会重拼、重烧。
       * 不用为复原另写一条流水线——那样迟早和主线漂开。
       */
      const jobId = await enqueueFilm(deps, name, req.params.id)
      return { queued: jobId !== null, jobId }
    })

  /**
   * 挑开头的【草稿】：挑一半也存住。
   *
   * 【为什么要有】：这一屏要在 68 段素材里翻，挑一半接个电话、切个 app
   * 是常态。不存的话，回来虽然还停在这一屏（闸门在），但挑过的那几段
   * 没了——那就等于"随时能离开"是个陷阱。
   *
   * 只写清单，【不动 opening_state】——它还是 pending，闸门仍然拦着。
   * 真正放行是 POST /opening 那一个。
   */
  app.post<{ Params: { id: string }; Body: { pick?: unknown } }>(
    '/api/projects/:id/opening/draft', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const pick = Array.isArray(req.body?.pick)
        ? req.body.pick.filter((x): x is string => typeof x === 'string')
        : []
      withUserDb(name, (db) => db.updateProject(req.params.id, {
        openingPickJson: JSON.stringify(pick),
      }))
      return { saved: pick.length }
    })

  /**
   * 分集那一屏的【草稿】：断点和引子选到哪儿就存到哪儿。
   * 同理——这一屏要读几百句慢慢比对，选一半走人是常态。
   */
  app.post<{ Params: { id: string }; Body: { breakIndex?: unknown; introEnd?: unknown } }>(
    '/api/projects/:id/split/draft', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const breakIndex = Number(req.body?.breakIndex)
      const introEnd = Number(req.body?.introEnd)
      if (!Number.isInteger(breakIndex) || !Number.isInteger(introEnd)) {
        return reply.code(400).send({ error: '草稿值不合法' })
      }
      withUserDb(name, (db) => db.updateProject(req.params.id, {
        splitDraftJson: JSON.stringify({ breakIndex, introEnd }),
      }))
      return { saved: true }
    })

  /**
   * 【自动补满开头】。作者按下「自动」时调它。
   *
   * body.pick = 他现在已经挑的那些（可以是空的）。
   * 返回**补完之后的完整清单**，前面是他自己挑的、原样不动，后面是补上的。
   *
   * ── 为什么放在服务端算 ──────────────────────────────────────────────
   * 这套"先让超出最少、再用更少的片子"的算法（compose 那边真按它铺）
   * 只该有【一份】实现。放前端就要再写一遍，两边迟早会漂——而漂了之后
   * 的症状是"界面说正好铺满、烧出来最后一段被切了"，极难查。
   *
   * ⚠️【只算，不落库、不放行】。作者按了自动只是把格子填上，他还可以接着
   * 改；真正定下来的是 POST /opening 那一个。
   */
  app.post<{ Params: { id: string }; Body: { pick?: unknown } }>(
    '/api/projects/:id/opening/autofill', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const need = project.headBoundaryMs
      if (need === null || need <= 0) {
        return reply.code(409).send({ error: '这条片子还没算出开头的长度，等配音生成完再试' })
      }

      const raw = Array.isArray(req.body?.pick)
        ? req.body.pick.filter((x): x is string => typeof x === 'string')
        : []

      const lib = openLibraryDb(libraryDataDir)
      try {
        const all = listBucket(lib, OPENING_BUCKET)
        const byId = new Map(all.map((it) => [it.id, it]))
        const bad = raw.filter((id) => !byId.has(id))
        if (bad.length > 0) {
          return reply.code(400).send({ error: `有 ${bad.length} 段素材不在开头素材库里，刷新一下再挑` })
        }
        const have = raw.reduce((sum, id) => sum + (byId.get(id)?.durationMs ?? 0), 0)
        if (have >= need) return { pick: raw, added: [] }   // 已经满了，没什么可补的

        /*
         * 候选：整个开头桶，去掉他已经选过的。
         *
         * 【先按项目 id 洗一遍】。背包算法只认时长，不认顺序——不洗的话
         * 每条片子都会挑到同样那几段（库里同长度的素材一大把）。
         * 洗过之后同样时长的选中的是不同的段，两条片子的开头才不会撞脸。
         *
         * 【续集还要避开主片用过的】。两集开头不一样是用户明确要求过的，
         * 不能指望随机自然分开——同一个 68 段的桶，按概率平均会撞上一段。
         */
        const used = new Set(raw)
        if (project.parentProjectId !== null) {
          for (const id of openingOf(lib, name, project.parentProjectId)) used.add(id)
        }
        const rand = rng(seedFrom(project.id))
        const pool = shuffled(all, rand).filter((it) => !used.has(it.id) && it.durationMs > 0)

        const added = fillToTarget(pool, need - have)
        return { pick: [...raw, ...added.map((x) => x.id)], added: added.map((x) => x.id) }
      } finally {
        lib.close()
      }
    })

  /**
   * 把这个项目挂起，等作者挑开头。
   *
   * ⚠️【必须在开始配音【之前】调，而且要等它返回】。配音一完成，服务端
   * 就会自己排合成——短文案十几秒就配完了。先发配音再挂起的话，
   * 那条片子已经拿着一套随机开头烧上了。
   *
   * 幂等：重复调只是再写一次同样的状态。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/opening/hold', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      withUserDb(name, (db) => db.updateProject(req.params.id, { openingState: 'pending' }))
      return { openingState: 'pending' }
    })

  /**
   * 敲定这个项目的开头素材，然后放行合成。
   *
   * body.pick 给了就用作者挑的；没给（或空）= 「用默认素材」。
   *
   * ⚠️【默认也要物化成一份具体清单】，不能只是"不填、回头现算"。
   * 排布本来是拿项目 id 当种子现算的，扫进新素材就会变（background.ts
   * 里写明的已知取舍）。作者在这一屏看过、认过的那几段，落库之后
   * 重烧多少次都还是那几段。
   *
   * ⚠️【续集的默认要避开主片的开头】。两集各用自己的种子洗牌，顺序不同，
   * 但抓的是同一个桶——按概率平均会撞上一段。用户要求两集开头不一样，
   * 所以在这里显式把主片用过的段剔掉，不指望随机自然分开。
   */
  app.post<{ Params: { id: string }; Body: { pick?: unknown } }>(
    '/api/projects/:id/opening', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const raw = Array.isArray(req.body?.pick)
        ? req.body.pick.filter((x): x is string => typeof x === 'string')
        : []

      const lib = openLibraryDb(libraryDataDir)
      let pick: string[]
      try {
        if (!hasVideoMaterials(lib)) {
          return reply.code(409).send({ error: '素材库里没有可用的视频素材，请先扫描素材库' })
        }
        /*
         * 只收开头桶里真实存在的 id。脏 id 落了库，排布那边只会默默跳过它，
         * 于是作者挑了 5 段、烧出来只有 3 段，而且没有任何地方报错。
         */
        const valid = new Set(listBucket(lib, OPENING_BUCKET).map((it) => it.id))
        const bad = raw.filter((id) => !valid.has(id))
        if (bad.length > 0) {
          return reply.code(400).send({ error: `有 ${bad.length} 段素材不在开头素材库里，刷新一下再挑` })
        }

        if (raw.length > 0) {
          /*
           * 【挑不够就不让确认】。开头段必须【正好】铺满到边界——分界固定，
           * 后半段才能在重选开头时原样复用。铺不满的话老逻辑会把缺口顺延给
           * 下一段，开头就跟着素材长短漂，那正是要根治的问题。
           *
           * ⚠️【不循环补齐】。同一个片子重复播，一眼就看出是凑数的。
           * 宁可挡在这里，把还差多少秒说清楚，让作者接着挑。
           */
          const need = project.headBoundaryMs
          if (need !== null && need > 0) {
            const dur = new Map(listBucket(lib, OPENING_BUCKET).map((it) => [it.id, it.durationMs]))
            const have = raw.reduce((sum, id) => sum + (dur.get(id) ?? 0), 0)
            if (have < need) {
              const short = Math.ceil((need - have) / 1000)
              return reply.code(400).send({
                error: `开头还差 ${short} 秒，请再多挑几段（需要 ${Math.ceil(need / 1000)} 秒）`,
                shortBySec: short,
                needMs: need,
              })
            }
          }
          pick = raw
        } else {
          // 「用默认素材」：把现算的默认排布物化下来
          const parentPick = project.parentProjectId === null
            ? []
            : openingOf(lib, name, project.parentProjectId)
          /*
           * 【默认清单也要铺满边界】，否则"用默认素材"物化出来的那几段
           * 加起来不到边界，下一次照这份清单排布就直接抛错——用户会卡在
           * 一条自己没挑过的片子上出不去。
           *
           * 万一整个开头桶加起来都不够长（68 段、理论上才可能），退回原来的
           * 顺延逻辑并记日志：这条片子不定长、不支持重选开头，但至少能烧出来。
           */
          const defOpts = {
            sequel: project.parentProjectId !== null,
            excludeOpening: parentPick,
          }
          try {
            pick = openingIdsOf(planProjectBackground(
              lib, project.id, project.ttsDurationMs,
              {
                ...defOpts,
                headBoundaryMs: project.headBoundaryMs,
                layoutRatio: parseLayoutRatio(project.layoutRatioJson),
              },
            ))
          } catch (e: unknown) {
            req.log.warn({ err: e, projectId: project.id }, '开头桶铺不满边界，默认排布退回顺延逻辑')
            pick = openingIdsOf(planProjectBackground(lib, project.id, project.ttsDurationMs, defOpts))
          }
        }
      } finally {
        lib.close()
      }

      withUserDb(name, (db) => db.updateProject(req.params.id, {
        openingPickJson: JSON.stringify(pick),
        openingState: 'settled',
      }))

      // 闸门放行：这一刻才轮到它排队
      void enqueueFilm(deps, name, req.params.id)
        .catch((e: unknown) => { req.log.warn({ err: e }, '开头敲定后入队失败，稍后由状态接口补排') })

      return { openingPick: pick }
    })

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
        // 续集用另一套素材公式（几段开头 + 全程跑酷），见 background.ts
        return planProjectBackground(lib, project.id, project.ttsDurationMs,
          {
            sequel: project.parentProjectId !== null,
            // 挑过的按挑的铺；没挑过（老项目）是空数组 → 走原来的洗牌，指纹不变
            openingPick: parseOpeningPick(project.openingPickJson),
            /*
             * 【三个产出排布的地方必须传同一个边界】：烧录、预拼、预览接口。
             * 漏掉任何一个，那一处算出的排布就和别处不同——预览里看到的
             * 和烧出来的不是同一条片子，而这种错极难排查。
             * 老项目这一列是 null，三处一致地走老逻辑。
             */
            headBoundaryMs: project.headBoundaryMs,
            layoutRatio: parseLayoutRatio(project.layoutRatioJson),
          })
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
