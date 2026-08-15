import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { sendFileRange } from '../assets/storage.js'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { synthesize, synthesizeLong } from './index.js'
import { isAllowedVoice, clampRate, clampVolume, clampPitch } from './voices.js'
import { normalizeScript } from '../importers/sanitize.js'
import { enqueueFilm, type FilmDeps } from '../compose/film.js'
import { overlongRuns } from '../subtitles/segment.js'
import { headBoundary } from '../subtitles/head-boundary.js'
import { deriveSubtitleLines } from '../subtitles/project-ass.js'
import type { WordTiming } from '../types.js'
import { planCuts, SUBTITLE_CUT_MAX } from '../subtitles/cut-ai.js'
import { ensureAudioStats } from '../audio/routes.js'

interface Deps extends FilmDeps {
  /** 仅供测试注入假合成，生产不传——真调 Azure 会烧配额 */
  synthesizeLong?: typeof synthesizeLong
}

export function registerTtsRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps
  const synth = deps.synthesizeLong ?? synthesizeLong

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  /**
   * 【试听】。合成文案开头一小段（不是整篇），确认前就能听到当前
   * 音色/语速/音量/音调的效果——否则每调一下都要等十几分钟整篇重做。
   * 参数从请求体来（草稿值），不改项目、不入库、不触发合成。只合一句，
   * Azure 花销可忽略。音频字节直接回给前端，不落盘、不建素材记录。
   */
  app.post<{ Params: { id: string }; Body: {
    voice?: unknown; rate?: unknown; volume?: unknown; pitch?: unknown
  } }>(
    '/api/projects/:id/voice/preview', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const voice = isAllowedVoice(req.body?.voice) ? req.body.voice : project.voiceName
      const rate = req.body?.rate !== undefined ? clampRate(req.body.rate) : project.voiceRate
      const volume = req.body?.volume !== undefined ? clampVolume(req.body.volume) : project.voiceVolume
      const pitch = req.body?.pitch !== undefined ? clampPitch(req.body.pitch) : project.voicePitch
      const sample = sampleText(normalizeScript(project.scriptText))

      const key = process.env.AZURE_SPEECH_KEY
      const region = process.env.AZURE_SPEECH_REGION
      if (!key || !region) return reply.code(500).send({ error: '服务端未配置配音服务' })

      const dir = join(tmpdir(), `sj-preview-${randomUUID()}`)
      await mkdir(dir, { recursive: true })
      const out = join(dir, 'preview.mp3')
      try {
        await synthesize({ text: sample, outPath: out, voice, rate, volume, pitch, key, region })
        const buf = await readFile(out)
        reply.header('Content-Type', 'audio/mpeg')
        reply.header('Cache-Control', 'no-store')
        return reply.send(buf)
      } catch (e) {
        req.log.error(e)
        return reply.code(502).send({ error: e instanceof Error ? e.message : '试听合成失败' })
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })

  /**
   * 配音的【音频流】。给播放器单独拉一条轨用。
   *
   * ⚠️ 母带现在只有画面，配音不在里面——预览要自己把画面/配音/音乐三条
   * 叠起来播（见 hooks/useFilmPlayback.ts）。所以这条接口是预览能出声的前提，
   * 不是可选的附属品。
   *
   * 走 sendFileRange：播放器要 seek，必须支持 Range，否则拖进度条会整条重下。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/voice/stream', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const path = join(assetDir(name, whitelist, req.params.id), 'voice.mp3')
      if (!existsSync(path)) return reply.code(404).send({ error: '还没有配音' })
      return sendFileRange(reply, path, req.headers.range, 'audio/mpeg')
    })

  /**
   * 生成配音。设计文档第 6 节：这是【手动触发】的——
   * 改一个字就自动重配会烧配额、撞 F0 的 20 次/60 秒限速。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/voice', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      /*
       * ⚠️【标点原样送进 Azure，一个都不换】。停顿完全由作者自己打的标点决定：
       * 这条流水线上的文案是"一行一句、行尾一个逗号"，Azure 看到逗号就停一下，
       * 短促而连贯——这正是要的效果。我们不做任何符号替换或补全。
       */
      const text = normalizeScript(project.scriptText)
      if (!text) return reply.code(400).send({ error: '文案是空的，先写点内容再生成配音' })

      /*
       * 【状态阻拦】：开了改名的文本项目，必须先确认人名替换才能配音。
       * 只作用于文本路（karaoke）+ renameEnabled；自备(line)和关了改名的
       * 项目不拦。未确认就配音会拿到没改名的文案，白烧一遍。
       */
      if (project.renameEnabled && project.subtitleMode !== 'line' && project.renameState !== 'confirmed') {
        return reply.code(409).send({ error: '请先在「文案」里确认人名替换，再生成配音' })
      }

      // 【不再按长度拒绝】：Azure 单次 10 分钟的上限现在由 synthesizeLong
      // 内部自动切段消化，超长文案不需要用户手工拆项目。
      const key = process.env.AZURE_SPEECH_KEY
      const region = process.env.AZURE_SPEECH_REGION
      if (!key || !region) {
        req.log.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION')
        return reply.code(500).send({ error: '服务端未配置配音服务，请联系管理员' })
      }

      withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'generating' }))

      try {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })
        const outPath = join(dir, 'voice.mp3')

        // 配音参数从项目取（前端在触发生成前已经 patch 进去了）。
        // 音色/语速/音量/音调对文本配音路生效；自备音频路根本不到这里。
        const result = await synth({
          text, outPath, key, region,
          voice: project.voiceName,
          rate: project.voiceRate,
          volume: project.voiceVolume,
          pitch: project.voicePitch,
        })

        const updated = withUserDb(name, (db) => {
          // 旧的配音素材记录先清掉，避免堆积
          for (const a of db.listAssets(req.params.id, 'voice')) db.deleteAsset(a.id)
          db.addAsset({
            projectId: req.params.id, kind: 'voice', path: result.audioPath,
            originalName: 'voice.mp3', size: 0, durationMs: result.durationMs,
          })
          return db.updateProject(req.params.id, {
            ttsState: 'ready',
            ttsDurationMs: result.durationMs,
            wordTimingsJson: JSON.stringify(result.words),
          })
        })

        /*
         * 【配音一就绪，成片就该开始合】——用户不用再点「导出视频」。
         * 到这一步为止，文案、配音、字幕、BGM 全都定下来了，剩下的几分钟
         * 里需要他做的事是零，那就不该占用他的注意力。
         *
         * enqueueFilm 会先把背景轨排进队列再排成片（背景轨是成片的输入，
         * 队列是 FIFO 串行的，顺序就此保证）。
         *
         * 不 await：这是后台活儿，配音接口不该为它多等一秒。
         * 失败也只记一行日志——入队没成功顶多是用户下次打开时由状态接口
         * 补排一条，绝不该让他看到一个"配音失败"。
         */
        /*
         * ⚠️【开头待定就先别排】。走新建项目那条线的项目，配音完了还有一屏
         * 让作者挑开头素材。这时候排队等于拿一套随机开头把片子烧掉，
         * 等他挑完还得重烧一遍——白烧十几分钟，他还会先看到一条不是自己
         * 挑的片子。挑完（或按了「用默认素材」）由那个接口负责排。
         */
        // ⚠️ 顺序要紧：边界必须在合成入队【之前】落库，排布要用它
        settleHeadBoundary(name, whitelist, req.params.id)
        planSubtitleCuts(name, whitelist, req.params.id, req.log)
        // 【预加载】配音一好就把波形和响度量出来，用户点进音频那一屏时数据已经在了
        void ensureAudioStats(name, whitelist, req.params.id, deps.libraryDataDir)
          .catch(() => { /* 量不出不影响出片，接口那边会再试一次 */ })

        if (openingPending(name, whitelist, req.params.id)) {
          req.log.info({ project: req.params.id }, '开头待挑，先不排合成')
        } else {
          void enqueueFilm(deps, name, req.params.id)
            .catch((e: unknown) => { req.log.warn({ err: e }, '成片自动合成入队失败，稍后由状态接口补排') })
        }

        /*
         * ── 续集跟着一起配 ─────────────────────────────────────────────
         * 拆过集的项目，主片配完就该轮到续集，用户不该再去点第二次。
         *
         * 【为什么放在服务端而不是前端接着发一次请求】：前端那条路要求页面
         * 一直开着。用户按下生成就切走/锁屏是常态，页面一走，续集就永远
         * 停在草稿——而他以为两条都在跑。放这儿就跟页面无关了。
         *
         * 【串行、不并发】：Azure 有限速，两条一起发只会互相拖。而且续集
         * 排在后面本来也要等，先后顺序还正好是观众看的顺序。
         */
        void (async () => {
          const kids = withUserDb(name, (db) => db.listProjects()
            .filter((p) => p.parentProjectId === req.params.id && p.ttsState === 'none'
              && (p.scriptText ?? '').trim() !== ''))
          for (const kid of kids) {
            try {
              await synthesizeProject(deps, name, whitelist, kid.id, key, region, synth)
              req.log.info({ sequel: kid.id }, '续集配音完成，已排合成')
            } catch (e) {
              req.log.warn({ err: e, sequel: kid.id }, '续集配音失败，用户可在那条项目里重试')
            }
          }
        })()

        return {
          ttsState: updated!.ttsState,
          durationMs: result.durationMs,
          wordCount: result.words.length,
          // 前端据此提示「已分 N 段合成」。1 表示走的是直通路径。
          segmentCount: result.segmentCount,
        }
      } catch (e) {
        withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'error' }))
        req.log.error(e)
        // synthesize 的错误信息本身是给用户看的（配额耗尽/限流/超时），透传
        return reply.code(502).send({ error: e instanceof Error ? e.message : '配音失败' })
      }
    })
}

/**
 * 给一条项目配音：合成 → 写素材 + 词级时间轴 → 排成片。
 *
 * 抽出来是为了让【续集】能走完全一样的一条路。复制一份的话，两处迟早
 * 分叉——而分叉的表现是"续集的字幕/时间轴和主片规则不一样"，极难发现。
 */
/**
 * 配音完成后算一次字幕的语义断点。
 *
 * ⚠️【只能在这一刻算】：断点要落在词边界上，而词级时间戳是配音才有的。
 * 也不能放到渲染时算——烧录和预览都是同步读 ASS，那儿不能有网络调用。
 *
 * ⚠️【失败不能影响配音】：这一步只让字幕更好看，算不出来就退回机械切法。
 * 所以整段包在 try 里，也不 await——配音接口不该为它多等十几秒。
 */
/**
 * 【配音一完成就把开头段的边界算好写死】。
 *
 * 为「重选开头」服务：只要这个分界永远落在同一时刻，后半段就能原样复用，
 * 用户重选开头时只重烧那一两分钟，而不是整条 14 分钟。
 *
 * ⚠️【必须在这一刻算，而且只算这一次】。词级时间戳是配音的产物，
 * 在这一刻定死、之后永不改变——边界锚在它上面才是不可动摇的。
 * 换成"每次现算"的话，比例常数以后一调，老项目的边界就跟着漂，
 * 盘上那份后半段立刻对不上新时间轴。
 *
 * ⚠️【同步做，不能异步】。它必须在合成入队【之前】写进库：排布要用它来
 * 定开头段长度，晚一步的话这一次烧的就是没有定长开头的版本，
 * 而用户看到的却是"支持重选开头"。
 *
 * 算不出来（字幕太少、末尾大段静音）就留 null——那只意味着这条片子
 * 不支持重选开头，不该让它连烧都烧不了。
 *
 * ── 为什么可以先于语义切分算 ──────────────────────────────────────
 * 这一刻断点还没落库，拿到的是逗号切出来的原始句。之后 planSubtitleCuts
 * 会把超过 14 字的句子【在句子内部】再切开——切出来的最后一片仍然结束在
 * 原来那一句的句尾。所以边界永远还是某一句的句尾，句末对齐不会被破坏。
 * （代价只是切分之后可能出现一个更早的句尾也 ≥ 目标，于是开头比"最紧"的
 * 那个选择长零点几秒——无所谓，反正取的就是大的那一边。）
 */
function settleHeadBoundary (userName: string, whitelist: string[], projectId: string): void {
  try {
    const db = openUserDb(userName, whitelist)
    try {
      const project = db.getProject(projectId)
      if (!project) return
      // 自备 SRT 那条路没有"开头桶"的概念，不支持重选开头
      if (project.subtitleMode === 'line') return
      if (project.headBoundaryMs !== null) return   // 已经定过，终身不改
      const b = headBoundary(deriveSubtitleLines(project), project.ttsDurationMs ?? 0)
      if (b === null) return
      db.updateProject(projectId, { headBoundaryMs: b.endMs })
    } finally { db.close() }
  } catch { /* 算不出边界不该影响配音本身已经成功这件事 */ }
}

function planSubtitleCuts (userName: string, whitelist: string[], projectId: string, log: {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
}): void {
  void (async () => {
    try {
      const db = openUserDb(userName, whitelist)
      let project
      try { project = db.getProject(projectId) } finally { db.close() }
      if (!project || project.subtitleMode === 'line') return

      /*
       * 送去切的是【机械切法必须硬断的段】，不是"切完还超限的行"——
       * 后者恒为空（机械切法本来就以上限收口），整层 LLM 会永远不触发。
       * 绕明白这件事花了一轮，见 segment.ts 的 overlongRuns。
       */
      const words: WordTiming[] = JSON.parse(project.wordTimingsJson ?? '[]')
      const runs = overlongRuns(words, SUBTITLE_CUT_MAX)
      if (runs.length === 0) return
      const texts = runs.map((r) => r.text)
      const cuts = await planCuts(texts)
      if (cuts.size === 0) return

      const map: Record<string, number[]> = {}
      for (const [k, pts] of cuts) {
        const t = texts[k]
        if (t !== undefined) map[t] = pts
      }
      const db2 = openUserDb(userName, whitelist)
      try { db2.updateProject(projectId, { subtitleCutsJson: JSON.stringify(map) }) } finally { db2.close() }
      log.info({ project: projectId, 要切的段: runs.length, 切成功: cuts.size }, '字幕语义切分完成')
    } catch (e) {
      log.warn({ err: e, project: projectId }, '字幕语义切分失败，退回机械切法（不影响出片）')
    }
  })()
}

/** 这个项目是不是还等着作者挑开头 */
function openingPending (userName: string, whitelist: string[], projectId: string): boolean {
  const db = openUserDb(userName, whitelist)
  try {
    return db.getProject(projectId)?.openingState === 'pending'
  } finally {
    db.close()
  }
}

async function synthesizeProject (
  deps: Deps, userName: string, whitelist: string[], projectId: string,
  key: string, region: string, synth: typeof synthesizeLong,
): Promise<void> {
  const withDb = <T>(fn: (db: ReturnType<typeof openUserDb>) => T): T => {
    const db = openUserDb(userName, whitelist)
    try { return fn(db) } finally { db.close() }
  }
  const project = withDb((db) => db.getProject(projectId))
  if (!project) return
  const text = normalizeScript(project.scriptText)
  if (!text) return

  withDb((db) => db.updateProject(projectId, { ttsState: 'generating' }))
  try {
    const dir = assetDir(userName, whitelist, projectId)
    await mkdir(dir, { recursive: true })
    const result = await synth({
      text, outPath: join(dir, 'voice.mp3'), key, region,
      voice: project.voiceName, rate: project.voiceRate,
      volume: project.voiceVolume, pitch: project.voicePitch,
    })
    withDb((db) => {
      for (const a of db.listAssets(projectId, 'voice')) db.deleteAsset(a.id)
      db.addAsset({
        projectId, kind: 'voice', path: result.audioPath,
        originalName: 'voice.mp3', size: 0, durationMs: result.durationMs,
      })
      db.updateProject(projectId, {
        ttsState: 'ready', ttsDurationMs: result.durationMs,
        wordTimingsJson: JSON.stringify(result.words),
      })
    })
    settleHeadBoundary(userName, whitelist, projectId)
    planSubtitleCuts(userName, whitelist, projectId, console as never)
    void ensureAudioStats(userName, whitelist, projectId, deps.libraryDataDir)
      .catch(() => { /* 同上 */ })

    // 续集同理：开头没挑完就不排，见上面那段
    if (!openingPending(userName, whitelist, projectId)) {
      await enqueueFilm(deps, userName, projectId)
    }
  } catch (e) {
    withDb((db) => db.updateProject(projectId, { ttsState: 'error' }))
    throw e
  }
}

/**
 * 试听样段：取文案开头、到最近一个句末标点为止，最多约 50 字。
 * 太短听不出语气，太长白烧配额还让人等。空文案给一句固定示例。
 */
function sampleText (script: string): string {
  const s = script.trim()
  if (!s) return '这是配音的试听效果，你可以听听音色和语速合不合适。'
  const head = [...s].slice(0, 50).join('')
  const m = /[。！？；…]/.exec(head)
  return m ? head.slice(0, head.indexOf(m[0]) + 1) : head
}
