import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { buildAssForProject, aspectOf } from '../subtitles/project-ass.js'
import { render } from '../render/index.js'
import { openLibraryDb } from '../library/library-db.js'
import { getLibraryItem } from '../library/scan.js'
import { libraryItemPath } from '../library/paths.js'
import { hasVideoMaterials, planProjectBackground, type BackgroundPlan } from '../library/background.js'
import { buildBackgroundTrack } from '../compose/build.js'
import { BG_TRACK_FILE, planFingerprint, reusableBgTrack, writeStamp } from '../compose/prebuild.js'
import type { Clip } from '../types.js'
import type { ExportQueue } from './queue.js'

interface Deps {
  whitelist: string[]
  queue: ExportQueue
  /** 素材库所在的 data 根目录（全局公用，不经过 userDbDir） */
  libraryDataDir: string
}

/**
 * 背景轨生成在整条导出进度里占的比重。
 *
 * 拍脑袋定的 30%：一条 13 分钟的成片要截十几段再拼，几分钟起步，
 * 【不能让进度条在这段时间里一动不动】——那和卡死没有区别。
 * 精确的比重取决于素材和机器，也没必要精确：进度条要的是"在动"。
 */
const BG_TRACK_SHARE = 0.3

export function registerExportRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, queue, libraryDataDir } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/export', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const videos = withUserDb(name, (db) => db.listAssets(req.params.id, 'video'))
      if (videos.length > 1) {
        // 阶段 1 划界：多片段需要两趟渲染，尚未实现。显式报错而非悄悄出错。
        return reply.code(400).send({ error: '暂时只支持一个背景视频，请删掉多余的' })
      }

      /*
       * 【公式模式】：没有上传的背景视频 → 背景由素材库按三段式公式现拼。
       * 有上传的 → 走原来的单视频路径，行为一字不变。公式模式是新增，不是替换。
       */
      const uploaded = videos[0]
      const formulaMode = uploaded === undefined

      const voices = withUserDb(name, (db) => db.listAssets(req.params.id, 'voice'))
      const voice = voices[0]
      if (voice === undefined || project.ttsState !== 'ready') {
        /*
         * 配音先判。公式模式下【背景长度完全由配音决定】——没有配音就没有
         * 排布可算，"先传素材"那句老提示在这条路径上已经不成立了。
         */
        return reply.code(400).send({ error: '还没有配音，先点「生成配音」' })
      }

      /*
       * 素材库只在真用得上时才打开：旧路径 + 没选库里的 BGM 时，
       * 一次都不该去碰它。
       */
      let plan: BackgroundPlan | null = null
      let libraryBgmPath: string | undefined
      if (formulaMode || project.bgmLibraryId !== null) {
        const lib = openLibraryDb(libraryDataDir)
        try {
          if (formulaMode) {
            /*
             * 库里一条视频都没有是【能靠扫库解决的状态问题】，必须在提交前
             * 说清楚。不先判这一下，planBackground 会在队列里抛错，
             * 用户只看到一句 ffmpeg 风格的天书。
             */
            if (!hasVideoMaterials(lib)) {
              return reply.code(400).send({ error: '素材库里没有可用的视频素材，请先扫描素材库' })
            }
            plan = planProjectBackground(lib, project.id, project.ttsDurationMs)
            if (plan.segments.length === 0) {
              return reply.code(400).send({ error: '算不出背景排布，请确认配音时长和素材库' })
            }
          }
          if (project.bgmLibraryId !== null) {
            const item = getLibraryItem(lib, project.bgmLibraryId)
            // 选中的 BGM 被从库里删掉了：不混 BGM 继续导出，别让整条导出失败。
            // 成片没有背景音乐是看得见的，比导出直接崩了好收拾。
            if (item !== null) libraryBgmPath = libraryItemPath(libraryDataDir, item)
          }
        } finally {
          lib.close()
        }
      }

      const bgms = withUserDb(name, (db) => db.listAssets(req.params.id, 'bgm'))
      const job = withUserDb(name, (db) => db.createJob(req.params.id))

      queue.enqueue(job.id, async (onProgress) => {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })

        // 字幕：从存下来的词级时间戳推导，不入库（设计文档第 4 节）。
        // ⚠️ 必须走共用的 buildAssForProject——预览接口调的是同一个函数，
        // 这是「预览即成片」的唯一保证。不要在这里另起一套构造逻辑。
        const aspect = aspectOf(project)
        const durationMs = project.ttsDurationMs ?? 0
        const ass = buildAssForProject(project)
        const assPath = join(dir, 'subtitle.ass')
        await writeFile(assPath, ass, 'utf-8')

        /*
         * 公式模式：先把三段排布拼成一条与配音等长的无声背景轨，
         * 再当作【单个背景视频】进现有烧录管线——烧录那一侧一行都不用改。
         *
         * fitMode 用 cover 而不是 blur：这条轨已经在 buildBackgroundTrack 里
         * 归一化到目标画幅了，cover 在这里是恒等变换。用 blur 会白白多做一遍
         * 高斯模糊叠底，纯浪费 CPU。
         */
        let clip: Clip
        if (plan !== null) {
          const trackPath = join(dir, BG_TRACK_FILE)
          /*
           * 【配音就绪时已经在后台拼过一条了】（src/compose/prebuild.ts）。
           * 指纹对得上就直接用，这一整段耗时归零。
           *
           * ⚠️ reusableBgTrack 【永远不抛】：预拼没成功、指纹文件读不出来、
           * 素材库被扫过导致排布变了——统统回 null，落到下面即时生成那条
           * 老路上。用户绝不该因为一个后台优化没做成就导不出片子。
           */
          const fingerprint = planFingerprint(plan.segments, aspect)
          const reuse = await reusableBgTrack(dir, fingerprint)
          if (reuse === null) {
            await buildBackgroundTrack({
              segments: plan.segments,
              dataDir: libraryDataDir,
              aspect, outPath: trackPath, workRoot: dir,
              onProgress: (p) => onProgress(p * BG_TRACK_SHARE),
            })
            // 这次现拼的也记上指纹，下次导出/预览就能直接用
            await writeStamp(dir, fingerprint).catch(() => { /* 记不上顶多下次重拼 */ })
          } else {
            // 跳过了就把这一段进度直接补满，别让进度条从 30% 起跳看着像卡过
            onProgress(BG_TRACK_SHARE * 100)
          }
          clip = { path: trackPath, fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }
        } else if (uploaded !== undefined) {
          clip = { path: uploaded.path, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }
        } else {
          // 提交前的校验保证走不到这里；真到了就是逻辑漏洞，明着炸掉
          throw new Error('既没有上传的背景视频，也没有可用的背景排布')
        }

        const outPath = join(dir, 'export.mp4')
        await render({
          clips: [clip],
          voicePath: voice.path,
          // 素材库里选的 BGM 优先；没选才回落到项目自己上传的那一首
          bgmPath: libraryBgmPath ?? bgms[0]?.path,
          bgmVolume: project.bgmVolume,
          assPath, aspect, durationMs, outPath,
        }, plan === null
          ? onProgress
          // 背景轨已经吃掉前 BG_TRACK_SHARE，烧录只推进剩下那一段
          : (p) => onProgress(BG_TRACK_SHARE * 100 + p * (1 - BG_TRACK_SHARE)))

        withUserDb(name, (db) => {
          for (const a of db.listAssets(req.params.id, 'export')) db.deleteAsset(a.id)
          db.addAsset({
            projectId: req.params.id, kind: 'export', path: outPath,
            originalName: `${project.name}.mp4`, size: 0, durationMs,
          })
        })
        return outPath
      })

      // 队列事件同步落库，让刷新页面后还能看到结果
      queue.on(job.id, (e) => {
        withUserDb(name, (db) => db.updateJob(job.id, {
          status: e.status === 'queued' ? 'queued' : e.status,
          progress: e.progress,
          error: e.error,
          outputPath: e.outputPath,
        }))
      })

      return { jobId: job.id, status: 'queued' }
    })

  /**
   * SSE 进度流。用 SSE 而非 WebSocket：进度只需服务器单向推，
   * SSE 是这个场景的原生答案（设计文档第 10 节）。
   * nginx 侧已配 proxy_buffering off，否则事件会被缓冲住不实时。
   */
  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/stream', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const job = withUserDb(name, (db) => db.getJob(req.params.jobId))
      if (!job) return reply.code(404).send({ error: '作业不存在' })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',   // 再保险一层：告诉 nginx 别缓冲
      })

      const send = (data: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      // 中途连上的客户端要能立刻看到当前进度，而不是干等
      const snap = queue.snapshot(req.params.jobId)
      send(snap ?? { jobId: job.id, status: job.status, progress: job.progress, error: job.error, outputPath: job.outputPath })

      const off = queue.on(req.params.jobId, (e) => {
        send(e)
        if (e.status === 'done' || e.status === 'error') {
          off()
          reply.raw.end()
        }
      })

      // 已经结束的作业，推完快照就关
      if (job.status === 'done' || job.status === 'error') {
        off()
        reply.raw.end()
        return
      }

      req.raw.on('close', () => { off() })
    })

  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/download', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const job = withUserDb(name, (db) => db.getJob(req.params.jobId))
      if (!job || job.status !== 'done' || !job.outputPath) {
        return reply.code(404).send({ error: '成片还没准备好' })
      }
      const project = withUserDb(name, (db) => db.getProject(job.projectId)) as Project | null
      const fileName = `${project?.name ?? 'surejack'}.mp4`
      reply.header('Content-Type', 'video/mp4')
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      return reply.send(createReadStream(job.outputPath))
    })
}
