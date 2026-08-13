import type { FastifyInstance } from 'fastify'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { sendFileRange, parseRange } from '../assets/storage.js'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { downloadableFilm, playableMaster, enqueueFilm, filmInfo, resolveFilm, FILM_STAMP_FILE, type FilmDeps } from '../compose/film.js'
import { checkpointOf, CHECKPOINT_LABEL, NEXT_STEP } from '../compose/checkpoint.js'
import { finishedSince } from './notify.js'
import { dropDelivered } from '../compose/deliver.js'
import { downloadPrep } from '../compose/download-queue.js'
import { buildPreview, hasPreview, previewDir } from '../compose/preview.js'
import { FILM_MASTER_FILE } from '../compose/film.js'
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
  /**
   * 有哪些片子在 since 之后做完了。给 app 的后台轮询用，一次问完。
   *
   * since 由客户端带（它记着自己上次看到哪儿），服务端不存"已读"——
   * 多设备各看各的，服务端也不必为"谁读过了"负责。
   * 不带 since 时只回最近 6 小时内的，免得第一次装上就弹出几十条历史通知。
   */
  app.get<{ Querystring: { since?: string } }>(
    '/api/notifications', { preHandler: requireAuth }, async (req) => {
      const name = getSession(req)!
      const raw = Number(req.query?.since)
      const since = Number.isFinite(raw) && raw > 0 ? raw : Date.now() - 6 * 3600_000
      const items = await finishedSince(name, deps.whitelist, since)
      return { since, now: Date.now(), items }
    })

  /**
   * 失败之后重试：**从最近的 checkpoint 接着走，不从头再来**。
   *
   * 原来给用户的说法是"回项目里点『生成配音』重来一次"——那是把整条链
   * 从头走一遍：10 分钟配音 + 十几分钟烧录，而实际可能只是最后混一次音
   * 失败了。盘上本来就有一串天然的 checkpoint（见 compose/checkpoint.ts）。
   *
   * 做法：把失败的印记清掉，然后【按正常路径入队】（不是 force）。
   * 正常路径每一步开工前都拿指纹比对，对得上的直接跳过——于是
   * "从最远的完好产物接着走"是它本来就有的行为，不需要另写一套。
   *
   * ⚠️【不能用 force】。force 的语义是"不问指纹全部重来"，那正好是
   * 我们要避免的事。
   */
  /**
   * 备货：为下载现混一份成片。**同一条项目重复点会并到同一个任务**。
   *
   * 分成"备货"和"取货"两步，是因为混一条十几分钟的片子要几十秒。
   * 一步到位的话，那几十秒里界面什么都没有——用户以为没点上，连点几下，
   * 每一下各起一个 ffmpeg，把磁盘撑爆（线上真这么坏过）。
   *
   * 现在：点一下立刻回一个状态，客户端据此显示「合成中…」，好了再去取。
   */
  app.post<{ Params: { id: string }; Body: { preset?: unknown } }>(
    '/api/projects/:id/download/prepare', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const r = resolveFilm(deps, name, req.params.id)
      if (!r.ok) return reply.code(409).send({ error: r.error })

      const master = join(r.film.dir, FILM_MASTER_FILE)
      if (!existsSync(master)) {
        return reply.code(409).send({ error: '画面还没合好，稍等一下' })
      }

      /*
       * 【音量用哪一组】：默认用这条项目自己的；body.preset='default' 时
       * 用出厂默认（1 / 0.15）。列表里下载会让用户选——他可能只是想要
       * 一份"标准"的，不想为此改掉项目的设置。
       */
      const useDefault = req.body?.preset === 'default'
      const entry = downloadPrep.request(req.params.id, {
        dir: r.film.dir,
        voicePath: r.film.voicePath,
        voiceGain: useDefault ? 1 : project.voiceGain,
        bgmPath: r.film.bgmPath,
        bgmVolume: useDefault ? 0.15 : project.bgmVolume,
        coverTitle: r.film.coverTitle,
        aspect: r.film.aspect,
      }, statSync(master).size)

      return { state: entry.state, error: entry.error }
    })

  /**
   * 预览的 HLS 索引和分段。
   *
   * 母带实测 7.5 Mbps，而跨洲可用带宽常常只有 2–5 Mbps——播放速度追不上
   * 片子的码率，用户看到的就是一直转圈。这里给的是 540×960 / 约 1 Mbps 的
   * 分段版本，小七八倍，而且只拉当前要播的那几段。
   *
   * 【没有就现做】：老项目、或者母带刚重烧过的，第一次点开会等一下；
   * 之后一直复用。做的过程放在这条请求里等，是因为播放器拿不到索引就没法
   * 开始——先回一个 404 让它以为没有，反而更糟。
   */
  app.get<{ Params: { id: string; file: string } }>(
    '/api/projects/:id/preview/:file', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      /*
       * ⚠️ 文件名只允许索引和分段两种形态。这是个【拼路径的接口】，
       * 不挡的话 ../../ 就能读到素材目录外面去。
       */
      const f = req.params.file
      if (!/^(index\.m3u8|seg-\d{4}\.ts)$/.test(f)) {
        return reply.code(400).send({ error: '非法的分段名' })
      }

      const dir = assetDir(name, deps.whitelist, req.params.id)
      const master = join(dir, FILM_MASTER_FILE)
      if (!hasPreview(dir)) {
        if (!existsSync(master)) return reply.code(409).send({ error: '画面还没合好' })
        try {
          await buildPreview(dir, master)
        } catch (e) {
          req.log.error({ err: e }, '生成预览分段失败')
          return reply.code(500).send({ error: '预览生成失败' })
        }
      }

      const path = join(previewDir(dir), f)
      if (!existsSync(path)) return reply.code(404).send({ error: '分段不存在' })
      /*
       * 分段是【内容寻址】的：同一个索引里的 seg-0007.ts 永远是同一段字节，
       * 母带重烧会把整个目录清掉重来。所以可以放心长缓存。
       * 索引本身不缓存——它是那份"目录"，重做之后必须立刻拿到新的。
       */
      if (f.endsWith('.ts')) reply.header('Cache-Control', 'private, max-age=604800, immutable')
      else reply.header('Cache-Control', 'no-cache')
      return sendFileRange(reply, path,  req.headers.range,
        f.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl')
    })

  /** 备货到哪一步了。客户端拿它把「合成中…」换成真正的下载 */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/download/state', { preHandler: requireAuth }, async (req) => {
      const e = downloadPrep.snapshot(req.params.id)
      if (e === null) return { state: 'none' as const, error: null }
      return { state: e.state, error: e.error }
    })

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/retry', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const dir = assetDir(name, deps.whitelist, req.params.id)
      const from = checkpointOf(dir, { ttsReady: project.ttsState === 'ready' })

      /*
       * 配音那一步本身没成 → 只能从头。这时不排成片：没有配音就没有
       * 时间轴、没有排布长度，排下去也是立刻 blocked。
       */
      if (from === 'none') {
        return {
          from, label: CHECKPOINT_LABEL[from], next: NEXT_STEP[from],
          queued: false,
          hint: '配音还没成功，要从生成配音开始重来。',
        }
      }

      // 清掉失败印记，让正常路径重新判断
      await rm(join(dir, FILM_STAMP_FILE), { force: true })
      const jobId = await enqueueFilm(deps, name, req.params.id)
      return {
        from, label: CHECKPOINT_LABEL[from], next: NEXT_STEP[from],
        queued: jobId !== null, jobId,
      }
    })

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

      /*
       * ⚠️【取货，不是现混】。
       *
       * 混音归 /download/prepare 那一步（带去重、带磁盘检查）。这里只负责
       * 把备好的那份传出去。分开的理由是线上真踩过：一步到位的话，混音那
       * 几十秒里界面毫无反馈，用户以为没点上就连点几下，每一下各起一个
       * ffmpeg 各写几百 MB，把磁盘撑爆——而症状只是"下载键点了没反应"。
       *
       * 没备货就【就地备一次并等它】：安卓 DownloadManager 是直接来拉 URL 的，
       * 它不会先替我们调 prepare。
       */
      let entry = downloadPrep.snapshot(req.params.id)
      if (entry === null) {
        const r0 = resolveFilm(deps, name, req.params.id)
        if (!r0.ok) return reply.code(409).send({ error: r0.error })
        const m = join(r0.film.dir, FILM_MASTER_FILE)
        if (!existsSync(m)) return reply.code(409).send({ error: '画面还没合好' })
        downloadPrep.request(req.params.id, {
          dir: r0.film.dir, voicePath: r0.film.voicePath, voiceGain: project.voiceGain,
          bgmPath: r0.film.bgmPath, bgmVolume: project.bgmVolume,
          coverTitle: r0.film.coverTitle, aspect: r0.film.aspect,
        }, statSync(m).size)
      }
      entry = await downloadPrep.wait(req.params.id)
      if (entry === null || entry.state === 'error' || entry.path === null) {
        req.log.error({ err: entry?.error }, '下载时现混失败')
        return reply.code(409).send({ error: entry?.error ?? '还不能下载' })
      }
      const path = entry.path

      const size = statSync(path).size

      /*
       * ── 【断了要能续，别整条重来】────────────────────────────────
       *
       * 线上真事，一条 480MB 的片子连着三次下载失败，日志里全是
       * `stream closed prematurely`：传了 7 秒断、4 分 17 秒断、12 秒断。
       * 用户在手机上、跨运营商，IP 中途都换了——这种网络下一次拉完 480MB
       * 本来就是小概率事件。
       *
       * 而原来的代码把这件小概率的事变成了【不可能】：
       *   ① 明确不给 Accept-Ranges，所以每次重试都从第 0 字节重来；
       *   ② 'close' 在客户端断开时【也会触发】，于是一断就把混好的文件删了，
       *      重试还得先重混几十秒；
       *   ③ downloadedAt 在开传【之前】就写死了，三次失败照样算"下载过"，
       *      两小时后归档把母带删掉——从此这条片子彻底下不动。
       *
       * 三条一起修：声明支持 Range、断了把文件留着、传完才算数。
       */
      const range = parseRange(req.headers.range, size)
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${size}`)
        return reply.code(416).send({ error: '请求的字节区间超出文件范围' })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      /*
       * 这一次【是不是把最后一个字节也传了】。续传时客户端会分几次来拿，
       * 只有拿到尾巴的那一次才是真的下载完了——中间那几段传完就删的话，
       * 下一个 Range 请求会扑空，续传反而比不支持还糟。
       */
      const servesTail = end >= size - 1

      reply.header('Content-Type', 'video/mp4')
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}.mp4`)}`)
      reply.header('Accept-Ranges', 'bytes')
      /*
       * 【必须带 Content-Length】。只丢一个流出去的话 Fastify 走 chunked，
       * 响应里没有总长度 → 安卓 DownloadManager 把 total 记成 -1 →
       * 下载队列里"已下 30MB / —"、进度条永远 0%（真机上就是这样）。
       */
      reply.header('Content-Length', end - start + 1)
      if (range !== null) {
        reply.code(206)
        reply.header('Content-Range', `bytes ${start}-${end}/${size}`)
      }

      /*
       * 【传完才算数】——靠【数字节】判断，不看 HTTP 层的状态。
       *
       * 本来用的是 reply.raw.writableFinished，看着更直接，但它在 fastify
       * 的 inject 里根本不成立，测试当场就挂了；而"下载有没有传完"这件事
       * 也确实不该依赖某个 HTTP 实现的内部字段。
       * 读了多少字节是自明的：客户端一断开，流被销毁，读到的就少于该读的。
       */
      const expected = end - start + 1
      /*
       * 【把是谁在要、要哪一段记下来】。手机端下载失败时我们手上只有日志，
       * 而"下载中断"这四个字分不清是安卓 DownloadManager 在续传、
       * 还是 WebView 自己多发了一条——它俩会同时出现，看起来像重复下载。
       * User-Agent 一记就分得开。
       */
      req.log.info({
        project: req.params.id,
        段: range === null ? `整条 0-${size - 1}` : `${start}-${end}`,
        总MB: Math.round(size / 1048576),
        本次MB: Math.round(expected / 1048576),
        客户端: (req.headers['user-agent'] ?? '').slice(0, 60),
      }, '开始传成片')
      let sent = 0
      const stream = createReadStream(path, { start, end })
      stream.on('data', (c: Buffer | string) => { sent += c.length })
      stream.on('close', () => {
        if (sent < expected) {
          // 断了：文件【留着】，等它续传或重试。什么都不标记。
          req.log.warn({
            project: req.params.id,
            已传MB: Math.round(sent / 1048576),
            应传MB: Math.round(expected / 1048576),
            完成度: `${Math.round(sent / expected * 100)}%`,
            客户端: (req.headers['user-agent'] ?? '').slice(0, 60),
          }, '下载中断，成片留着等续传')
          return
        }
        if (!servesTail) return          // 只拿了中间一段，还没完

        /*
         * 【下载过的才会被归档，而且从这一刻开始算两小时】。
         * 没下载过说明还在打磨，收走等于帮倒忙——用户下次进来要等十几分钟。
         */
        withUserDb(name, (db) => db.updateProject(req.params.id, {
          downloadedAt: new Date().toISOString(),
          touchedAt: new Date().toISOString(),
        }))
        /*
         * 【取走即作废】：删文件、也把备货记录清掉。不清的话，用户改完音量
         * 再下一次，拿到的还是上一份——而他刚刚才亲手调过。
         */
        downloadPrep.drop(req.params.id)
        void dropDelivered(path)
        req.log.info({ project: req.params.id, MB: Math.round(size / 1048576) }, '下载完成，成片已清理')
      })

      return reply.send(stream)
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
      /*
       * ⚠️【先写"已取消"的印记，再停队列】。顺序反了就有一个真实的窗口：
       *
       *   queue.cancel()  → ffmpeg 被杀
       *   ...（几百毫秒）
       *   writeStamp()    → 才落盘
       *
       * 前端每 2 秒轮一次 /film，落在这中间的那一次看到的是"该有成片却没有、
       * 也没有取消印记"，于是【立刻又排一条】。用户看到的就是"我按了中断，
       * 进度条照样在走"——线上真发生了，库里能看到一条 cancelled 紧跟着
       * 一条新的 running。
       *
       * 印记先落盘，那一次轮询就会看到"已取消"，不会重排。
       */
      const r = resolveFilm(deps, name, req.params.id)
      if (r.ok) {
        await writeStamp(r.film.dir, FILM_STAMP_FILE, {
          fingerprint: r.film.fingerprint, status: 'cancelled', jobId: job.id,
        })
      }
      const stopped = queue.cancel(job.id)
      if (stopped) {
        withUserDb(name, (db) => db.updateJob(job.id, { status: 'cancelled', progress: 0 }))
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
