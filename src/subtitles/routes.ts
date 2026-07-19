import type { FastifyInstance } from 'fastify'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { buildAssForProject, deriveSubtitleLines } from './project-ass.js'

interface Deps { whitelist: string[] }

/**
 * 字幕的两个【只读派生】接口。
 *
 * 不新增数据库字段：字幕行和 ASS 都是 wordTimingsJson 的函数，每次现推
 * （设计文档第 4 节「不入库」）。
 *
 * ⚠️ ASS 一律走 buildAssForProject——前端 JASSUB 预览渲染的必须是
 * 与 ffmpeg 烧录逐字节相同的那一份，否则 WYSIWYG 就是空话。
 *
 * 鉴权同项目路由：用会话身份打开【那个人自己的库】，别人的项目 id
 * 在自己的库里查不到，自然 404，不需要 WHERE owner。
 */
export function registerSubtitleRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/subtitles', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      // 还没生成配音 → 空列表；项目不存在 → 404。
      // 前端要能区分这两件事，所以不能都用 404 糊过去。
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return { lines: deriveSubtitleLines(project) }
    })

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/subtitles.ass', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      reply.header('Content-Type', 'text/plain; charset=utf-8')
      // 派生数据随文案/配音/画幅随时变，缓存住就会出现「改了没反应」
      reply.header('Cache-Control', 'no-store')
      return reply.send(buildAssForProject(project))
    })
}
