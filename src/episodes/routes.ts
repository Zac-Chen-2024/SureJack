import type { FastifyInstance } from 'fastify'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { planSplit, allowedRange, type SplitPlan } from './split-ai.js'
import { splitSentences, totalEstimatedMs } from './sentences.js'
import { splitStory, sequelTitles, buildReminder } from './split.js'
import { inVideoTitleOf } from '../subtitles/project-ass.js'

/**
 * 分集：一条长文 → 主片 + 续集两个【独立项目】，用 parentProjectId 关联。
 *
 * ── 为什么是两个项目而不是一个项目两条片子 ────────────────────────
 * 一条片子从文案、配音、字幕、背景、封面到下载，整条流水线上的每一个
 * 环节都是"一个项目一份产物"。做成"一个项目两条片子"意味着这七处全都要
 * 改成一对多，而收益只是列表上少一行。做成两个项目，全部现成逻辑一行
 * 不用动，代价只是列表要按 parentProjectId 折叠——那是纯展示层的事。
 *
 * ── 分两步：先看，再拆 ──────────────────────────────────────────────
 * GET  /split/plan   AI 给断点候选 + 引子边界，**只读，不改任何东西**
 * POST /split        用户挑定之后才真的拆
 * 中间隔着用户的确认，是因为拆下去会改主片的正文（截短）并新建一个项目，
 * 这两件事都不该在他还没看清楚的时候发生。
 */

interface Deps {
  whitelist: string[]
  /** 仅供测试注入假分析，生产不传——真调 DeepSeek 会烧配额 */
  plan?: typeof planSplit
}

export function registerEpisodeRoutes (app: FastifyInstance, deps: Deps): void {
  const withUserDb = <T>(name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T => {
    const db = openUserDb(name, deps.whitelist)
    try { return fn(db) } finally { db.close() }
  }
  const doPlan = deps.plan ?? planSplit

  /**
   * 断点分析。返回给前端滚轮用的全部数据：
   * 每一句 + 累计时长（滚到哪儿显示多长）、AI 的候选、允许的范围。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/split/plan', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      const text = (project.scriptText ?? '').trim()
      if (text === '') return reply.code(400).send({ error: '还没有文案，无法分析断点' })

      let plan: SplitPlan
      try {
        plan = await doPlan(text)
      } catch (e) {
        // 分析失败要把原因原样带回去——前端有重试按钮，用户得知道在重试什么
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
      }
      const allowed = allowedRange(plan.sentences)
      return {
        /** 滚轮的每一格：句子原文 + 切到这里主片有多长 */
        sentences: plan.sentences.map((s) => ({
          index: s.index, text: s.text.trim(), cumulativeMs: s.cumulativeMs,
        })),
        candidates: plan.candidates,
        introEndIndex: plan.introEndIndex,
        introReason: plan.introReason,
        allowed,
        totalMs: totalEstimatedMs(plan.sentences),
        /** 提醒语长什么样，先给用户看一眼 */
        reminderPreview: buildReminder(inVideoTitleOf(project)),
      }
    })

  /**
   * 真的拆。主片正文被截短，续集作为【新项目】建出来并指回主片。
   *
   * ⚠️【改主片的正文会让它的母带指纹变】——也就是说这条片子要重烧。
   * 这是必然的：内容确实变了（结局被砍掉换成悬念）。所以拆分只该在
   * 配音之前做，界面上也把它放在"确认文案"那一步。
   */
  app.post<{ Params: { id: string }; Body: { breakIndex?: unknown; introEndIndex?: unknown } }>(
    '/api/projects/:id/split', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const breakIndex = Number(req.body?.breakIndex)
      const introEndIndex = Number(req.body?.introEndIndex)
      if (!Number.isInteger(breakIndex) || breakIndex < 0) {
        return reply.code(400).send({ error: '断点句号不合法' })
      }
      if (!Number.isInteger(introEndIndex) || introEndIndex < 0) {
        return reply.code(400).send({ error: '引子结束句号不合法' })
      }

      const result = withUserDb(name, (db) => {
        const project = db.getProject(req.params.id)
        if (!project) return { code: 404 as const, error: '项目不存在' }
        if (project.parentProjectId !== null) {
          return { code: 400 as const, error: '续集不能再拆一次' }
        }
        const text = (project.scriptText ?? '').trim()
        if (text === '') return { code: 400 as const, error: '还没有文案，无法拆分' }

        const sentences = splitSentences(text)
        const split = splitStory({
          text, breakIndex, introEndIndex,
          mainInVideoTitle: inVideoTitleOf(project), sentences,
        })

        /*
         * 【先建续集再截主片】。反过来的话，建续集那步万一失败，主片的
         * 结局已经被砍掉了——用户手上剩下一条讲了一半、又没有下集的片子，
         * 而原文只存在于他自己的剪贴板里。
         */
        const titles = sequelTitles(project)
        const sequel = db.createProject(titles.name)
        db.updateProject(sequel.id, {
          scriptText: split.sequelText,
          coverTitle: titles.coverTitle,
          inVideoTitle: titles.inVideoTitle,
          parentProjectId: project.id,
          episodeIndex: 2,
          // 画幅、音色这些跟着主片走，别让续集莫名其妙换个声音
          aspectRatio: project.aspectRatio,
          voiceName: project.voiceName,
          voiceRate: project.voiceRate,
          voiceVolume: project.voiceVolume,
          voicePitch: project.voicePitch,
          bgmLibraryId: project.bgmLibraryId,
          bgmVolume: project.bgmVolume,
          subtitleMarginV: project.subtitleMarginV,
          subtitleFontSize: project.subtitleFontSize,
        })
        db.updateProject(project.id, { scriptText: split.mainText })

        return {
          code: 200 as const,
          main: db.getProject(project.id)!,
          sequel: db.getProject(sequel.id)!,
          mainEstimatedMs: split.mainEstimatedMs,
          sequelEstimatedMs: split.sequelEstimatedMs,
        }
      })

      if (result.code !== 200) return reply.code(result.code).send({ error: result.error })
      return result
    })

  /**
   * 一键把项目名应用到两个标题上。
   *
   * 主片：封面标题 = 片内标题 = 项目名。
   * 续集：封面标题加「2」（告诉刷到的人前面还有一集），
   * 片内标题【不加】——两集是同一个故事，顶部那行就该是同一个名字。
   * 【只在用户点的那一下生效】——之后他手改了哪个都不会被这个逻辑覆盖，
   * 因为它压根不在渲染路径上，只是一次性写库。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/titles/apply-name', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const out = withUserDb(name, (db) => {
        const project = db.getProject(req.params.id)
        if (!project) return null
        // 站在主片的角度算：点在续集上也应该按主片的名字来推
        const main: Project = project.parentProjectId
          ? db.getProject(project.parentProjectId) ?? project
          : project
        db.updateProject(main.id, { coverTitle: main.name, inVideoTitle: main.name })
        const kids = db.listProjects().filter((p) => p.parentProjectId === main.id)
        for (const k of kids) {
          const t = sequelTitles({ name: main.name, inVideoTitle: main.name })
          db.updateProject(k.id, { coverTitle: t.coverTitle, inVideoTitle: t.inVideoTitle })
        }
        return db.listProjects().filter((p) => p.id === main.id || p.parentProjectId === main.id)
      })
      if (out === null) return reply.code(404).send({ error: '项目不存在' })
      return { projects: out }
    })
}
