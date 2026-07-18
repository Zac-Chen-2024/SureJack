import type { FastifyInstance } from 'fastify'
import { unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openUserDb, type AssetKind } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { saveAsset, isAllowedUpload } from './storage.js'
import { probeDurationMs } from '../render/probe.js'

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
      if (kind !== 'video' && kind !== 'bgm') {
        return reply.code(400).send({ error: '只能上传背景视频（kind=video）或背景音乐（kind=bgm）' })
      }

      // 早失败：项目必须存在且属于当前用户（库都是他自己的，查不到即不存在）
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const file = await req.file()
      if (!file) return reply.code(400).send({ error: '没有收到文件' })

      if (!isAllowedUpload(file.mimetype, file.filename, kind)) {
        return reply.code(400).send({
          error: kind === 'video'
            ? '不支持的视频格式，请上传 mp4 / mov / mkv / webm'
            : '不支持的音频格式，请上传 mp3 / wav / aac / m4a / flac',
        })
      }

      // 落盘用随机名 + 原扩展名，避免同名覆盖与奇怪字符
      const storedName = `${randomUUID()}${extname(file.filename).toLowerCase()}`
      const { path, size } = await saveAsset({
        userName: name, whitelist, projectId: req.params.id,
        fileName: storedName, stream: file.file,
      })

      // 探测时长——顺便验证这是个能解码的媒体文件（坏文件当场发现，不拖到导出）
      let durationMs: number | undefined
      try {
        durationMs = await probeDurationMs(path)
      } catch {
        await unlink(path).catch(() => {})
        return reply.code(400).send({ error: '这个文件无法解码，可能已损坏或不是有效的媒体文件' })
      }

      const asset = withUserDb(name, (db) => db.addAsset({
        projectId: req.params.id, kind, path,
        originalName: file.filename, size, durationMs,
      }))
      return asset
    })

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/assets', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return withUserDb(name, (db) => db.listAssets(req.params.id))
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
