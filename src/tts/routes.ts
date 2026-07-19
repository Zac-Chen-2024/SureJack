import type { FastifyInstance } from 'fastify'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { synthesizeLong } from './index.js'
import { normalizeScript } from '../importers/sanitize.js'
import { enqueueFilm, type FilmDeps } from '../compose/film.js'

interface Deps extends FilmDeps {
  /** 仅供测试注入假合成，生产不传——真调 Azure 会烧配额 */
  synthesizeLong?: typeof synthesizeLong
}

export function registerTtsRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps
  const synth = deps.synthesizeLong ?? synthesizeLong

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  /**
   * 生成配音。设计文档第 6 节：这是【手动触发】的——
   * 改一个字就自动重配会烧配额、撞 F0 的 20 次/60 秒限速。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/voice', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const text = normalizeScript(project.scriptText)
      if (!text) return reply.code(400).send({ error: '文案是空的，先写点内容再生成配音' })

      // 【不再按长度拒绝】：Azure 单次 10 分钟的上限现在由 synthesizeLong
      // 内部自动切段消化，超长文案不需要用户手工拆项目。
      const key = process.env.AZURE_SPEECH_KEY
      const region = process.env.AZURE_SPEECH_REGION
      if (!key || !region) {
        req.log.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION')
        return reply.code(500).send({ error: '服务端未配置配音服务，请联系管理员' })
      }

      withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'generating' }))

      try {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })
        const outPath = join(dir, 'voice.mp3')

        const result = await synth({ text, outPath, key, region })

        const updated = withUserDb(name, (db) => {
          // 旧的配音素材记录先清掉，避免堆积
          for (const a of db.listAssets(req.params.id, 'voice')) db.deleteAsset(a.id)
          db.addAsset({
            projectId: req.params.id, kind: 'voice', path: result.audioPath,
            originalName: 'voice.mp3', size: 0, durationMs: result.durationMs,
          })
          return db.updateProject(req.params.id, {
            ttsState: 'ready',
            ttsDurationMs: result.durationMs,
            wordTimingsJson: JSON.stringify(result.words),
          })
        })

        /*
         * 【配音一就绪，成片就该开始合】——用户不用再点「导出视频」。
         * 到这一步为止，文案、配音、字幕、BGM 全都定下来了，剩下的几分钟
         * 里需要他做的事是零，那就不该占用他的注意力。
         *
         * enqueueFilm 会先把背景轨排进队列再排成片（背景轨是成片的输入，
         * 队列是 FIFO 串行的，顺序就此保证）。
         *
         * 不 await：这是后台活儿，配音接口不该为它多等一秒。
         * 失败也只记一行日志——入队没成功顶多是用户下次打开时由状态接口
         * 补排一条，绝不该让他看到一个"配音失败"。
         */
        void enqueueFilm(deps, name, req.params.id)
          .catch((e: unknown) => { req.log.warn({ err: e }, '成片自动合成入队失败，稍后由状态接口补排') })

        return {
          ttsState: updated!.ttsState,
          durationMs: result.durationMs,
          wordCount: result.words.length,
          // 前端据此提示「已分 N 段合成」。1 表示走的是直通路径。
          segmentCount: result.segmentCount,
        }
      } catch (e) {
        withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'error' }))
        req.log.error(e)
        // synthesize 的错误信息本身是给用户看的（配额耗尽/限流/超时），透传
        return reply.code(502).send({ error: e instanceof Error ? e.message : '配音失败' })
      }
    })
}
