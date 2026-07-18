import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { ASPECT_PRESETS } from '../config.js'
import { segmentLines, buildAss } from '../subtitles/index.js'
import { render } from '../render/index.js'
import type { ExportQueue } from './queue.js'
import type { WordTiming, TextOverlay } from '../types.js'

interface Deps { whitelist: string[]; queue: ExportQueue }

const SUBTITLE_MAX_CHARS = 14
const DISCLAIMER = '小说内容纯属虚构，无不良引导'

export function registerExportRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, queue } = deps

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
      if (videos.length === 0) {
        return reply.code(400).send({ error: '还没有背景视频，先上传一个' })
      }
      if (videos.length > 1) {
        // 阶段 1 划界：多片段需要两趟渲染，尚未实现。显式报错而非悄悄出错。
        return reply.code(400).send({ error: '暂时只支持一个背景视频，请删掉多余的' })
      }

      const voices = withUserDb(name, (db) => db.listAssets(req.params.id, 'voice'))
      if (voices.length === 0 || project.ttsState !== 'ready') {
        return reply.code(400).send({ error: '还没有配音，先点「生成配音」' })
      }

      const bgms = withUserDb(name, (db) => db.listAssets(req.params.id, 'bgm'))
      const job = withUserDb(name, (db) => db.createJob(req.params.id))

      queue.enqueue(job.id, async (onProgress) => {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })

        // 字幕：从存下来的词级时间戳推导，不入库（设计文档第 4 节）
        const words: WordTiming[] = JSON.parse(project.wordTimingsJson ?? '[]')
        const lines = segmentLines(words, SUBTITLE_MAX_CHARS)
        const aspect = ASPECT_PRESETS[project.aspectRatio] ?? ASPECT_PRESETS['9:16']!
        const durationMs = project.ttsDurationMs ?? 0

        const overlays: TextOverlay[] = [
          { content: DISCLAIMER, style: 'Disclaimer', startMs: null, endMs: null },
          { content: project.name, style: 'Title', startMs: null, endMs: null },
        ]
        const ass = buildAss({ lines, overlays, aspect, durationMs, mode: project.subtitleMode })
        const assPath = join(dir, 'subtitle.ass')
        await writeFile(assPath, ass, 'utf-8')

        const outPath = join(dir, 'export.mp4')
        await render({
          clips: [{ path: videos[0]!.path, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
          voicePath: voices[0]!.path,
          bgmPath: bgms[0]?.path,
          bgmVolume: project.bgmVolume,
          assPath, aspect, durationMs, outPath,
        }, onProgress)

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
