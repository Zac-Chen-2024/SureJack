import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'node:fs'
import { sendFileRange } from '../assets/storage.js'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { downloadableFilm, enqueueFilm, filmInfo, resolveFilm, type FilmDeps } from '../compose/film.js'

type Deps = FilmDeps

export function registerExportRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, queue } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  /**
   * 【手动】重新合成。
   *
   * 成片本来在配音就绪时就自动合好了（src/compose/film.ts），所以这个
   * 接口不再是主流程——它是给"我就是想强制重来一遍"留的那扇门，
   * 界面上对应一个不起眼的次要入口，不是主按钮。
   *
   * force：不问指纹，哪怕盘上那条还对得上也重合。用户会点它，正是因为
   * 他不信任盘上那条；这时候回一句"已经是最新的了"完全是答非所问。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/export', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const r = resolveFilm(deps, name, req.params.id)
      if (!r.ok) return reply.code(r.code === 'missing' ? 404 : 400).send({ error: r.error })

      const jobId = await enqueueFilm(deps, name, req.params.id, { force: true })
      if (jobId === null) return reply.code(400).send({ error: '暂时还不能合成成片' })
      return { jobId, status: 'queued' }
    })

  /**
   * 成片现在什么情况。「下载视频」那个按钮的唯一数据来源。
   *
   * 【会顺手补合】：该有却没有的时候就地入队，前端不用另外调一次导出。
   * 详见 src/compose/film.ts 的 filmInfo。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/film', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return filmInfo(deps, name, req.params.id)
    })

  /**
   * 下载成片。
   *
   * 【按项目取而不是按作业 id 取】：成片是项目当前的产物，不是某一次
   * 作业的纪念品。按作业取的话，服务重启后前端手里那个 jobId 就没了，
   * 一条明明躺在盘上的成片会变得下载不到。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/film/download', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const path = await downloadableFilm(deps, name, req.params.id)
      if (path === null) return reply.code(404).send({ error: '成片还没合好' })

      reply.header('Content-Type', 'video/mp4')
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}.mp4`)}`)
      return reply.send(createReadStream(path))
    })

  /**
   * 成片的【播放】流。和 /download 同一个文件，两点不同：
   *
   *   - 没有 Content-Disposition：带 attachment 的话 <video src> 在部分
   *     浏览器上会变成下载而不是播放。
   *   - 支持 Range：拖进度条发的是 206 请求，只回 200 的话浏览器要把
   *     整条几百 MB 的片子拉完才能跳，等于拖不动。
   *
   * 预览播的就是这个——「前端只是一个播放器」的字面意思：所见即成片，
   * 不存在预览和导出长得不一样的可能。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/film/stream', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const path = await downloadableFilm(deps, name, req.params.id)
      if (path === null) return reply.code(404).send({ error: '成片还没合好' })

      /*
       * 【不能缓存】。成片路径是固定的 export.mp4，改文案/字幕/BGM 之后
       * 重合出来的还是这个 URL——让浏览器缓存就等于用户改完设置看到的
       * 永远是旧片子。
       */
      reply.header('Cache-Control', 'no-store')
      return sendFileRange(reply, path, req.headers.range, 'video/mp4')
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
