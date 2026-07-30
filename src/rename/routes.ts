import type { FastifyInstance } from 'fastify'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { analyzeNovel } from './deepseek.js'
import { coerceAnalysis } from './deepseek.js'
import { applyRename } from './replace.js'
import type { RenameAnalysis } from './types.js'

interface Deps {
  whitelist: string[]
  /** 仅供测试注入假分析，生产不传——真调 DeepSeek 会烧配额 */
  analyze?: typeof analyzeNovel
}

/** renameAnalysisJson 存的形状：原文（供再次套用）+ 当前提案。 */
interface StoredAnalysis { source: string; analysis: RenameAnalysis }

function parseStored (json: string | null): StoredAnalysis | null {
  if (!json) return null
  try {
    const o = JSON.parse(json) as Partial<StoredAnalysis>
    if (typeof o?.source !== 'string' || o.analysis === undefined) return null
    return { source: o.source, analysis: coerceAnalysis(o.analysis) }
  } catch { return null }
}

/**
 * 人名谐音替换的两步接口（+ 开关）。
 *
 *  analyze  → 调 DeepSeek 出"去章节 + 谐音 + 关系"提案，落库(proposed)。
 *  confirm  → 用（可能被用户编辑过的）映射，确定性套用到【原文】，把
 *             scriptText 覆写成处理后文本(去章节+改名)，置 confirmed。
 *  toggle   → 开/关这个项目的改名链。
 *
 * 铁律：LLM 只出映射，applyRename 确定性执行；scriptText 永远从【原文】
 * 重算（原文存在 analysisJson.source 里），可反复改映射不叠加。
 */
export function registerRenameRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps
  const analyze = deps.analyze ?? analyzeNovel

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  // ── 分析（API-1）─────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/rename/analyze', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      if (project.subtitleMode === 'line') {
        return reply.code(400).send({ error: '自备配音的项目不走改名' })
      }
      // 已确认过的：scriptText 已是处理后文本，要在【原文】上重新分析
      const stored = parseStored(project.renameAnalysisJson)
      const source = project.renameState === 'confirmed' && stored ? stored.source : project.scriptText
      if (!source.trim()) return reply.code(400).send({ error: '文案是空的，先写点内容再分析人名' })

      let analysis: RenameAnalysis
      try {
        analysis = await analyze(source)
      } catch (e) {
        req.log.error({ err: e }, '人名分析失败')
        return reply.code(502).send({ error: e instanceof Error ? e.message : '人名分析失败' })
      }

      withUserDb(name, (db) => db.updateProject(project.id, {
        renameAnalysisJson: JSON.stringify({ source, analysis } satisfies StoredAnalysis),
        renameMapJson: JSON.stringify(analysis),
        renameState: 'proposed',
      }))
      return reply.send({ analysis })
    })

  // ── 确认（可带编辑后的映射）→ 套用、覆写 scriptText ────────────────
  app.post<{ Params: { id: string }; Body: { analysis?: unknown } }>(
    '/api/projects/:id/rename/confirm', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const stored = parseStored(project.renameAnalysisJson)
      const source = stored?.source ?? project.scriptText
      // 用户编辑过就用请求体的映射，否则用已存的提案
      const map = req.body?.analysis !== undefined
        ? coerceAnalysis(req.body.analysis)
        : (stored?.analysis ?? coerceAnalysis(JSON.parse(project.renameMapJson ?? 'null')))

      const processed = applyRename(source, map)
      const updated = withUserDb(name, (db) => db.updateProject(project.id, {
        scriptText: processed,
        renameMapJson: JSON.stringify(map),
        renameState: 'confirmed',
      }))
      return reply.send(updated)
    })

  // ── 开/关改名链 ──────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { enabled?: unknown } }>(
    '/api/projects/:id/rename/toggle', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const enabled = req.body?.enabled === true
      const updated = withUserDb(name, (db) => db.updateProject(req.params.id, { renameEnabled: enabled }))
      if (!updated) return reply.code(404).send({ error: '项目不存在' })
      return reply.send(updated)
    })
}
