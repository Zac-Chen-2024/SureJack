import type { FastifyInstance } from 'fastify'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLibraryDb } from '../library/library-db.js'
import { listBucket } from '../library/scan.js'
import { libraryItemPath } from '../library/paths.js'

/**
 * 字幕尺子（/subtitle-lab）。
 *
 * 一个【一次性的】量尺工具：模拟一屏成片画面 + 一行字幕，把字号和高度
 * 调到满意，提交上来。不接项目、不改默认值、不进任何流程——它的产出是
 * 两个数字，给人看的。
 *
 * ── 为什么不要登录 ──────────────────────────────────────────────────
 * 这是拿在手上比划的工具，最好是打开就能用。它不读任何用户数据：底图来自
 * 公共素材库、提交只写一行到日志。加一道登录只会让"在手机上随手看一眼"
 * 变成一件要下决心的事。
 */

/** 底图从这两个桶里各取一张：一张亮、一张花，字幕最容易糊的两种情况 */
const FRAME_SOURCES: { bucket: string; label: string }[] = [
  { bucket: '3-地铁跑酷', label: '地铁跑酷（花、亮）' },
  { bucket: '1-开头', label: '开头段（真实拍摄）' },
]

export function registerLabRoutes (app: FastifyInstance, deps: { dataDir: string }): void {
  const labDir = join(deps.dataDir, 'subtitle-lab')

  /**
   * 底图。**用素材库里真实的一帧**，不是纯色块——纯色底上什么字号都清楚，
   * 而字幕会不会糊，糊的正是高光和杂色多的那种画面。
   *
   * 抽一次存一次：ffmpeg 抽帧几百毫秒，滑块每动一下都抽就没法用了。
   */
  app.get<{ Params: { i: string } }>('/api/subtitle-lab/frame/:i.jpg', async (req, reply) => {
    const i = Number(req.params.i)
    const src = FRAME_SOURCES[i]
    if (!src) return reply.code(404).send({ error: '没有这张底图' })

    mkdirSync(labDir, { recursive: true })
    const out = join(labDir, `frame-${i}.jpg`)
    if (!existsSync(out)) {
      const db = openLibraryDb(deps.dataDir)
      const items = listBucket(db, src.bucket).filter((it) => it.durationMs > 3000)
      const item = items[Math.floor(items.length / 2)] ?? items[0]
      if (!item) return reply.code(404).send({ error: '素材库里没有可用的片段' })
      const path = libraryItemPath(deps.dataDir, item)
      await new Promise<void>((resolve, reject) => {
        execFile('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', '3', '-i', path,
          // 和成片同样的填充方式，这样这一帧的构图就是真实构图
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
          '-frames:v', '1', '-q:v', '3', out,
        ], (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()))
      })
    }
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.type('image/jpeg').send(readFileSync(out))
  })

  /** 有哪几张底图可选 */
  app.get('/api/subtitle-lab/frames', async () => ({
    frames: FRAME_SOURCES.map((f, i) => ({ i, label: f.label })),
  }))

  /**
   * 提交调好的参数。
   *
   * 【追加一行，不覆盖】：同一个人会调好几轮，后面那次不一定比前面好。
   * 全留着，看的时候自己挑。
   */
  app.post<{ Body: { fontSize?: unknown; marginV?: unknown; note?: unknown; frame?: unknown } }>(
    '/api/subtitle-lab/submit', async (req, reply) => {
      const fontSize = Number(req.body?.fontSize)
      const marginV = Number(req.body?.marginV)
      if (!Number.isFinite(fontSize) || !Number.isFinite(marginV)) {
        return reply.code(400).send({ error: '参数不是数字' })
      }
      mkdirSync(labDir, { recursive: true })
      const row = {
        at: new Date().toISOString(),
        fontSize: Math.round(fontSize),
        marginV: Math.round(marginV),
        frame: Number(req.body?.frame) || 0,
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '',
        ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
      }
      appendFileSync(join(labDir, 'submissions.jsonl'), `${JSON.stringify(row)}\n`, 'utf-8')
      req.log.info({ row }, '字幕尺子：收到一组参数')
      return { ok: true }
    })
}
