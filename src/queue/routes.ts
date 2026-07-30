import type { FastifyInstance } from 'fastify'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { sendFileRange } from '../assets/storage.js'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { downloadableFilm, playableMaster, enqueueFilm, filmInfo, resolveFilm, FILM_STAMP_FILE, type FilmDeps } from '../compose/film.js'
import { writeStamp } from '../compose/stamp.js'
import {
  COVER_IMAGE, COVER_THUMB_FILE, COVER_THUMB_TITLE_FILE, COVER_THUMB_WIDTH,
  coverTitleOf, renderCoverImage,
} from '../cover/cover.js'
import { aspectOf } from '../subtitles/project-ass.js'
import { assetDir } from '../assets/storage.js'
import { mkdir } from 'node:fs/promises'

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
      /*
       * 【必须带 Content-Length】。只丢一个流出去的话 Fastify 走 chunked，
       * 响应里没有总长度 → 安卓 DownloadManager 把 total 记成 -1 →
       * 下载队列里"已下 30MB / —"、进度条永远 0%（真机上就是这样）。
       * 文件就躺在盘上，长度是白拿的，没有不给的理由。
       * Accept-Ranges 顺手给上：断了能续传，不用整条重来。
       */
      reply.header('Content-Length', statSync(path).size)
      reply.header('Accept-Ranges', 'bytes')
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
   * 【母带】播放流。预览播它，BGM 在浏览器里另叠一条音轨。
   *
   * 母带 = 画面 + 烧录字幕 + 配音，不含 BGM。换 BGM 只换浏览器那条音轨、
   * 这个视频流一帧不动，所以换 BGM 不再重载视频、不再等服务器混音。
   * 支持 Range（能拖进度条）。带上 v=<masterVersion> 让浏览器缓存友好：
   * 母带没变时命中缓存，母带变了（改文案/字幕/语速）URL 变、自然重取。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/film/master/stream', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const path = await playableMaster(deps, name, req.params.id)
      if (path === null) return reply.code(404).send({ error: '母带还没合好' })

      // 母带按版本区分 URL（前端带 ?v=masterVersion），同版本可缓存
      reply.header('Cache-Control', 'no-store')
      return sendFileRange(reply, path, req.headers.range, 'video/mp4')
    })

  /**
   * 【中断正在进行的合成】。
   *
   * 一条片子要烧十几分钟，跑错了必须能立刻叫停：既省 CPU（四核机器上一条
   * 烧录会把一切都拖慢），也不让用户干等一条自己已经不要的片子。
   * 还在排队 → 从队列摘掉；正在跑 → 杀掉 ffmpeg（见 queue.cancel）。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/film/cancel', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const job = withUserDb(name, (db) => db.latestJob(req.params.id))
      if (!job) return reply.code(404).send({ error: '这个项目没有在合成' })
      const stopped = queue.cancel(job.id)
      if (stopped) {
        withUserDb(name, (db) => db.updateJob(job.id, { status: 'cancelled', progress: 0 }))
        /*
         * 【必须把"已取消"写进指纹文件】。只停队列不落盘的话，下一次状态
         * 轮询发现"该有成片却没有"，立刻又排一条——取消等于没点。
         * 指纹一起写：用户改了任何输入就会重排，符合直觉。
         */
        const r = resolveFilm(deps, name, req.params.id)
        if (r.ok) {
          await writeStamp(r.film.dir, FILM_STAMP_FILE, {
            fingerprint: r.film.fingerprint, status: 'cancelled', jobId: job.id,
          })
        }
      }
      // 没停到什么也回 200：用户想要的结果（现在没有在跑）已经成立
      return { cancelled: stopped, jobId: job.id }
    })

  /**
   * 【成片首帧封面】。给 <video poster> 用。
   *
   * 为什么要这个：不给 poster 的话，安卓 WebView 在视频真正解出第一帧之前会
   * 画一个又大又丑的默认播放键占位图——点进项目先看到那个，非常不专业。
   * 有了 poster，进页面【立刻】就是画面本身。
   *
   * 首次请求用 ffmpeg 从母带抓一帧存成 jpg，之后直接命中磁盘缓存。
   * 文件名带母带版本，母带重烧后自然换新（旧的留着无妨，下次不会被引用）。
   */
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>(
    '/api/projects/:id/film/poster.jpg', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const master = await playableMaster(deps, name, req.params.id)
      if (master === null) return reply.code(404).send({ error: '母带还没合好' })

      const posterPath = join(dirname(master), 'poster.jpg')
      // 封面比母带旧就重抓（母带重烧过）
      const fresh = existsSync(posterPath)
        && statSync(posterPath).mtimeMs >= statSync(master).mtimeMs
      if (!fresh) {
        try {
          await new Promise<void>((resolve, reject) => {
            const p = spawn('ffmpeg', [
              '-y', '-ss', '0', '-i', master, '-frames:v', '1',
              '-q:v', '3', posterPath,
            ])
            p.on('error', reject)
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))))
          })
        } catch (e) {
          req.log.warn({ err: e }, '抓封面失败')
          return reply.code(404).send({ error: '封面暂不可用' })
        }
      }
      /*
       * 带 ?v=<母带版本> 的请求可以放心长缓存（内容随版本变，版本变 URL 就变）。
       * 【不带 v 的不能缓存】：预览过渡屏在还不知道版本时就要先把第一帧显示
       * 出来，只能请求裸 URL——那条要是也缓存一天，重烧之后它会拿旧封面。
       */
      const versioned = typeof (req.query as { v?: string })?.v === 'string'
      reply.header('Cache-Control', versioned ? 'public, max-age=86400' : 'no-cache')
      return reply.type('image/jpeg').send(readFileSync(posterPath))
    })

  /**
   * 这个项目的封面缩略图。项目列表每一行左边那块就是它——列表上看到的
   * 必须就是这条片子发出去别人看到的第一眼，而不是一个占位色块。
   *
   * 【和成片有没有合好无关】：封面只由底图 + 标题决定，草稿状态的项目
   * 也该有封面。所以这里不查母带、不查成片，直接画。
   *
   * 缓存：画完连标题一起存着，标题没变就直接回文件（画一张约 100ms，
   * 列表每行都要，不缓存的话滚动一下就是十几次 ffmpeg）。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/cover.jpg', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const dir = assetDir(name, deps.whitelist, req.params.id)
      const title = coverTitleOf(project)
      const thumb = join(dir, COVER_THUMB_FILE)
      const titleFile = join(dir, COVER_THUMB_TITLE_FILE)
      const cached = existsSync(thumb) && existsSync(titleFile)
        && readFileSync(titleFile, 'utf-8') === title
      if (!cached) {
        const full = aspectOf(project)
        const w = COVER_THUMB_WIDTH
        const h = Math.round(w * full.height / full.width)
        await mkdir(dir, { recursive: true })
        await renderCoverImage({
          imagePath: COVER_IMAGE, title,
          aspect: { name: full.name, width: w, height: h },
          outPath: thumb,
        })
        writeFileSync(titleFile, title, 'utf-8')
      }
      // 标题变了 URL 会带上新的 v=，所以这份可以放心长缓存
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.type('image/jpeg').send(readFileSync(thumb))
    })

  /**
   * 固定封面底图。给前端画「封面标题」那个小预览用——它要和成片里
   * 真正用的那张是同一张，否则预览就是在骗人。
   */
  app.get('/api/cover/preview.jpg', { preHandler: requireAuth }, async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.type('image/jpeg').send(readFileSync(COVER_IMAGE))
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
