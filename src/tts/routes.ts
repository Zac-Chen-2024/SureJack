import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { synthesize, synthesizeLong } from './index.js'
import { isAllowedVoice, clampRate, clampVolume, clampPitch } from './voices.js'
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
   * 【试听】。合成文案开头一小段（不是整篇），确认前就能听到当前
   * 音色/语速/音量/音调的效果——否则每调一下都要等十几分钟整篇重做。
   * 参数从请求体来（草稿值），不改项目、不入库、不触发合成。只合一句，
   * Azure 花销可忽略。音频字节直接回给前端，不落盘、不建素材记录。
   */
  app.post<{ Params: { id: string }; Body: {
    voice?: unknown; rate?: unknown; volume?: unknown; pitch?: unknown
  } }>(
    '/api/projects/:id/voice/preview', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const voice = isAllowedVoice(req.body?.voice) ? req.body.voice : project.voiceName
      const rate = req.body?.rate !== undefined ? clampRate(req.body.rate) : project.voiceRate
      const volume = req.body?.volume !== undefined ? clampVolume(req.body.volume) : project.voiceVolume
      const pitch = req.body?.pitch !== undefined ? clampPitch(req.body.pitch) : project.voicePitch
      const sample = sampleText(normalizeScript(project.scriptText))

      const key = process.env.AZURE_SPEECH_KEY
      const region = process.env.AZURE_SPEECH_REGION
      if (!key || !region) return reply.code(500).send({ error: '服务端未配置配音服务' })

      const dir = join(tmpdir(), `sj-preview-${randomUUID()}`)
      await mkdir(dir, { recursive: true })
      const out = join(dir, 'preview.mp3')
      try {
        await synthesize({ text: sample, outPath: out, voice, rate, volume, pitch, key, region })
        const buf = await readFile(out)
        reply.header('Content-Type', 'audio/mpeg')
        reply.header('Cache-Control', 'no-store')
        return reply.send(buf)
      } catch (e) {
        req.log.error(e)
        return reply.code(502).send({ error: e instanceof Error ? e.message : '试听合成失败' })
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })

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

      /*
       * 【状态阻拦】：开了改名的文本项目，必须先确认人名替换才能配音。
       * 只作用于文本路（karaoke）+ renameEnabled；自备(line)和关了改名的
       * 项目不拦。未确认就配音会拿到没改名的文案，白烧一遍。
       */
      if (project.renameEnabled && project.subtitleMode !== 'line' && project.renameState !== 'confirmed') {
        return reply.code(409).send({ error: '请先在「文案」里确认人名替换，再生成配音' })
      }

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

        // 配音参数从项目取（前端在触发生成前已经 patch 进去了）。
        // 音色/语速/音量/音调对文本配音路生效；自备音频路根本不到这里。
        const result = await synth({
          text, outPath, key, region,
          voice: project.voiceName,
          rate: project.voiceRate,
          volume: project.voiceVolume,
          pitch: project.voicePitch,
        })

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

/**
 * 试听样段：取文案开头、到最近一个句末标点为止，最多约 50 字。
 * 太短听不出语气，太长白烧配额还让人等。空文案给一句固定示例。
 */
function sampleText (script: string): string {
  const s = script.trim()
  if (!s) return '这是配音的试听效果，你可以听听音色和语速合不合适。'
  const head = [...s].slice(0, 50).join('')
  const m = /[。！？；…]/.exec(head)
  return m ? head.slice(0, head.indexOf(m[0]) + 1) : head
}
