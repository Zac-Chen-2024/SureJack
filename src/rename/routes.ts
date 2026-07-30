import type { FastifyInstance } from 'fastify'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { analyzeNovel, reviewCleanup, coerceAnalysis, coerceReview, type ReviewResult } from './deepseek.js'
import { applyRename, stripChapters } from './replace.js'
import type { RenameAnalysis } from './types.js'

interface Deps {
  whitelist: string[]
  /** 仅供测试注入假分析，生产不传——真调 DeepSeek 会烧配额 */
  analyze?: typeof analyzeNovel
  /** 同上，复查（API-2） */
  review?: typeof reviewCleanup
}

/**
 * renameAnalysisJson 存的形状：
 *   source   —— 原文（每次确认都从它重算，改映射不叠加）
 *   analysis —— 第一层的提案
 *   review   —— 第二层复查捞到的漏网内容（前端展示 + 重试用）
 *   reviewError —— 复查失败的原因（失败【不阻塞】确认，但要让用户看见并能重试）
 */
interface StoredAnalysis {
  source: string
  analysis: RenameAnalysis
  review?: ReviewResult | null
  reviewError?: string | null
}

function parseStored (json: string | null): StoredAnalysis | null {
  if (!json) return null
  try {
    const o = JSON.parse(json) as Partial<StoredAnalysis>
    if (typeof o?.source !== 'string' || o.analysis === undefined) return null
    return {
      source: o.source,
      analysis: coerceAnalysis(o.analysis),
      review: o.review ? coerceReview(o.review) : null,
      reviewError: typeof o.reviewError === 'string' ? o.reviewError : null,
    }
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
  const review = deps.review ?? reviewCleanup

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

      // 第一层：确定性套用（去非正文 + 改名）
      let processed = applyRename(source, map)

      /*
       * 第二层（API-2）：复查第一层的产物，捞漏网的非正文——尤其【孤立的
       * 数字行】那种只有语义能判、字符规则抓不到的。仍然是"LLM 出指令、
       * 代码删"：它只回 removeLines，删由 stripChapters 执行。
       * 【失败不阻塞】：确认照常完成，把错误记下来让前端显示 + 可重试。
       */
      let reviewResult: ReviewResult | null = null
      let reviewError: string | null = null
      try {
        reviewResult = await review(processed)
        if (reviewResult.removeLines.length > 0) {
          processed = stripChapters(processed, reviewResult.removeLines)
        }
      } catch (e) {
        reviewError = e instanceof Error ? e.message : '清理复查失败'
        req.log.warn({ err: e }, '清理复查失败，沿用第一层结果')
      }

      const updated = withUserDb(name, (db) => db.updateProject(project.id, {
        scriptText: processed,
        renameMapJson: JSON.stringify(map),
        renameAnalysisJson: JSON.stringify({
          source, analysis: map, review: reviewResult, reviewError,
        } satisfies StoredAnalysis),
        renameState: 'confirmed',
      }))
      return reply.send(updated)
    })

  /*
   * 单独重跑复查（前端的「重试复查」按钮）。
   * 已确认的项目：在【当前文案】上再过一遍 API-2，捞出来的继续删掉。
   * 这样某次 DeepSeek 抽风/超时不会让用户卡住——点一下就能重来。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/rename/review', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const stored = parseStored(project.renameAnalysisJson)
      if (!project.scriptText.trim()) {
        return reply.code(400).send({ error: '文案是空的，没什么可复查的' })
      }
      try {
        const r = await review(project.scriptText)
        const processed = r.removeLines.length > 0
          ? stripChapters(project.scriptText, r.removeLines)
          : project.scriptText
        const updated = withUserDb(name, (db) => db.updateProject(project.id, {
          scriptText: processed,
          renameAnalysisJson: JSON.stringify({
            source: stored?.source ?? project.scriptText,
            analysis: stored?.analysis ?? coerceAnalysis(null),
            review: r, reviewError: null,
          } satisfies StoredAnalysis),
        }))
        return reply.send({ project: updated, review: r })
      } catch (e) {
        req.log.error({ err: e }, '清理复查重试失败')
        return reply.code(502).send({ error: e instanceof Error ? e.message : '清理复查失败' })
      }
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
