import type { FastifyInstance } from 'fastify'
import { unlink, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openUserDb, type AssetKind } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { saveAsset, isAllowedUpload, playbackMimeFor, parseRange } from './storage.js'
import { probeDurationMs } from '../render/probe.js'
import { FONTS_DIR } from '../config.js'

interface Deps { whitelist: string[] }

export function registerAssetRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
    '/api/projects/:id/assets', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const kind = req.query.kind as AssetKind
      if (kind !== 'video' && kind !== 'bgm' && kind !== 'voice' && kind !== 'srt') {
        return reply.code(400).send({
          error: '只能上传背景视频（video）、背景音乐（bgm）、配音（voice）或字幕（srt）',
        })
      }

      // 早失败：项目必须存在且属于当前用户（库都是他自己的，查不到即不存在）
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const file = await req.file()
      if (!file) return reply.code(400).send({ error: '没有收到文件' })

      const FORMAT_ERROR: Record<typeof kind, string> = {
        video: '不支持的视频格式，请上传 mp4 / mov / mkv / webm',
        bgm: '不支持的音频格式，请上传 mp3 / wav / aac / m4a / flac',
        voice: '不支持的配音格式，请上传 mp3 / wav / m4a / aac',
        srt: '字幕文件必须是 .srt（整句时间轴）',
      }
      if (!isAllowedUpload(file.mimetype, file.filename, kind)) {
        return reply.code(400).send({ error: FORMAT_ERROR[kind] })
      }

      // 被替换掉的旧文件路径，落库成功后再删（见下）
      const staleFiles: string[] = []
      // 落盘用随机名 + 原扩展名，避免同名覆盖与奇怪字符
      const storedName = `${randomUUID()}${extname(file.filename).toLowerCase()}`
      const { path, size } = await saveAsset({
        userName: name, whitelist, projectId: req.params.id,
        fileName: storedName, stream: file.file,
      })

      // 探测时长——顺便验证这是个能解码的媒体文件（坏文件当场发现，不拖到导出）。
      // ⚠️ **srt 要跳过**：它是纯文本，不是媒体，ffprobe 一定失败，
      // 探测的话每一个合法字幕文件都会被误判成「已损坏」。
      let durationMs: number | undefined
      if (kind !== 'srt') {
        try {
          durationMs = await probeDurationMs(path)
        } catch {
          await unlink(path).catch(() => {})
          return reply.code(400).send({ error: '这个文件无法解码，可能已损坏或不是有效的媒体文件' })
        }
      }

      const asset = withUserDb(name, (db) => {
        /*
         * 配音和字幕【各只能有一份】，重复上传是替换而不是追加：下游
         * （adopt-srt、导出）都是按 kind 取第一条，堆两份的话谁也说不清
         * 用的是哪个。旧记录连同文件一起删。
         *
         * video / bgm 【故意不这么做】——一个项目挂多段背景素材是正常
         * 用法，一起改成替换会把老项目的背景轨删到只剩一条。
         */
        if (kind === 'voice' || kind === 'srt') {
          for (const old of db.listAssets(req.params.id, kind)) {
            if (old.path !== path) staleFiles.push(old.path)
            db.deleteAsset(old.id)
          }
        }
        return db.addAsset({
          projectId: req.params.id, kind, path,
          originalName: file.filename, size, durationMs,
        })
      })
      // 记录已经删了才动文件：删文件失败不该让接口报错（记录才是真相）
      for (const stale of staleFiles) await unlink(stale).catch(() => {})
      return asset
    })

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/assets', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return withUserDb(name, (db) => db.listAssets(req.params.id))
    })

  /**
   * 取素材文件本身（前端预览要拿背景视频和配音 mp3）。
   *
   * 支持 Range：`<video>` / `<audio>` 拖进度条时发的是 206 请求，只回 200
   * 全文的话浏览器会把整个几百 MB 的背景视频拖完才肯 seek——在 4G 上等同于
   * 卡死。Accept-Ranges 头也必须回，否则浏览器根本不会尝试 seek。
   *
   * 越权在结构上不可能：assetId 是在【当前会话身份自己的库】里查的，
   * 别人的 assetId 在这个库里查不到，直接 404。
   */
  app.get<{ Params: { assetId: string } }>(
    '/api/assets/:assetId', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const asset = withUserDb(name, (db) => db.getAsset(req.params.assetId))
      if (!asset) return reply.code(404).send({ error: '素材不存在' })

      let size: number
      try {
        size = (await stat(asset.path)).size
      } catch {
        // 记录还在但文件没了（手工删过 data/、盘满回滚……）——说清楚，别回 500
        return reply.code(404).send({ error: '素材文件已丢失' })
      }

      reply.header('Content-Type', playbackMimeFor(asset.path))
      reply.header('Accept-Ranges', 'bytes')

      const range = parseRange(req.headers.range, size)
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${size}`)
        return reply.code(416).send({ error: '请求的字节区间超出文件范围' })
      }
      if (range) {
        reply.code(206)
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        reply.header('Content-Length', range.end - range.start + 1)
        return reply.send(createReadStream(asset.path, { start: range.start, end: range.end }))
      }
      reply.header('Content-Length', size)
      return reply.send(createReadStream(asset.path))
    })

  /**
   * 字幕字体。**故意直接吐 ffmpeg 用的那个文件**，不是另存一份到 web/public/。
   *
   * 设计文档第 7 节：JASSUB 不能用系统字体，必须由前端显式提供字体文件，
   * 而"两端同一个渲染器"的前提是【两端同一个字体文件】。从 FONTS_DIR 直接
   * 读，等于把这个不变量钉死在文件系统上——不存在"前端那份忘了跟着更新"
   * 的漂移，也不会有人把 web/public/ 里那份换成 Noto Sans SC（不存在的族名，
   * fc-match 会静默回退到没有中文字形的 DejaVu，渲染一片豆腐块且不报错）。
   *
   * 不挂 requireAuth：这是系统自带的公共字体，不含任何用户数据，而且
   * Worker 里的 fetch 带不带 cookie 有历史包袱，少一个失败点。
   */
  app.get('/api/fonts/subtitle.ttc', async (_req, reply) => {
    const path = join(FONTS_DIR, 'NotoSansCJK-Regular.ttc')
    try {
      const { size } = await stat(path)
      reply.header('Content-Type', 'font/collection')
      reply.header('Content-Length', size)
      // 20MB 的 CJK 字体，首次加载有感知——文件内容永不变，让浏览器长期缓存
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      return reply.send(createReadStream(path))
    } catch {
      return reply.code(500).send({ error: '服务器缺少字幕字体，请安装 fonts-noto-cjk' })
    }
  })

  app.delete<{ Params: { assetId: string } }>(
    '/api/assets/:assetId', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const asset = withUserDb(name, (db) => db.getAsset(req.params.assetId))
      if (!asset) return reply.code(404).send({ error: '素材不存在' })
      await unlink(asset.path).catch(() => { /* 文件可能已不在，记录仍要删 */ })
      withUserDb(name, (db) => db.deleteAsset(req.params.assetId))
      return { ok: true }
    })
}
