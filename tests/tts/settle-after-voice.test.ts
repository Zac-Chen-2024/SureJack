import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { userDbDir } from '../../src/auth/whitelist.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { settleAfterVoice } from '../../src/tts/settle-after-voice.js'
import { parseOpeningPick } from '../../src/library/background.js'
import { DEFAULT_RATIO } from '../../src/compose/plan.js'
import type { WordTiming } from '../../src/types.js'

/*
 * 【不变量】：head_boundary_ms 必须和【当前这份 wordTimings】同源。
 *
 * 写 tts_duration_ms 的地方一共三处（主片配音、续集配音、自备音频 adopt-srt），
 * 三处都要走这一个维护点。
 *
 * ⚠️ 这一组是被一串线上事故逼出来的：
 * 原来这个函数写着"已经定过，终身不改"，于是
 *   · 改文案 → 重新配音 → 边界还锚在【上一份配音】上，比例静默变形；
 *     新配音短过旧边界时排布还会悄悄退回不定长，这条片子从此失去重选开头
 *     能力而没人知道
 *   · 先做文本配音(有边界)、后来改自备音频 → 留着一个过期的边界，
 *     而自备那条路根本没有开头桶
 * 而"挑够了吗"那道闸判的正是这个边界，边界一错，整条链跟着错。
 */

const USER = '__测试同源__'
const LIST = [USER]
let dataDir: string
let lib: LibraryDb

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'settle-'))
  lib = openLibraryDb(dataDir)
  for (let i = 0; i < 20; i++) {
    lib.raw.prepare(
      `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`1-开头/k${i}.mp4`, '1-开头', `k${i}.mp4`, 10_000, 1000, '2026-08-16T00:00:00.000Z')
  }
  lib.close()
})
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
  await rm(userDbDir(USER, LIST), { recursive: true, force: true })
})

/** 每 500ms 一句的词级时间戳，凑出指定总长 */
function words (totalMs: number): WordTiming[] {
  const n = Math.floor(totalMs / 500)
  return Array.from({ length: n }, (_, i) => ({
    text: `第${i}句，`, offsetMs: i * 500, durationMs: 460, isPunctuation: false,
  }))
}

function seed (opts: { totalMs: number; mode?: 'karaoke' | 'line' }): string {
  const db = openUserDb(USER, LIST)
  const p = db.createProject('片子')
  db.updateProject(p.id, {
    ttsState: 'ready', ttsDurationMs: opts.totalMs,
    wordTimingsJson: JSON.stringify(words(opts.totalMs)),
    ...(opts.mode === 'line' ? { subtitleMode: 'line' } : {}),
  })
  db.close()
  return p.id
}

const read = (id: string) => {
  const db = openUserDb(USER, LIST)
  try { return db.getProject(id)! } finally { db.close() }
}

describe('分界跟着当前这份配音走', () => {
  it('第一次配音：算出分界，并把比例定下来', () => {
    const id = seed({ totalMs: 200_000 })
    settleAfterVoice(USER, LIST, id, dataDir)
    const p = read(id)
    expect(p.headBoundaryMs).toBeGreaterThan(0)
    expect(p.headBoundaryMs!).toBeLessThan(200_000)
    expect(JSON.parse(p.layoutRatioJson!)).toEqual([...DEFAULT_RATIO])
  })

  /*
   * ⚠️ 最要紧的一条。原来这里写着"已经定过，终身不改"——
   * 于是重新配音之后边界还锚在上一份配音上。
   */
  it('重新配音（总长变了）→ 分界跟着重算，不再抱着旧值', () => {
    const id = seed({ totalMs: 200_000 })
    settleAfterVoice(USER, LIST, id, dataDir)
    const first = read(id).headBoundaryMs!

    // 改文案重配：新配音短得多
    const db = openUserDb(USER, LIST)
    db.updateProject(id, { ttsDurationMs: 60_000, wordTimingsJson: JSON.stringify(words(60_000)) })
    db.close()
    settleAfterVoice(USER, LIST, id, dataDir)

    const after = read(id).headBoundaryMs!
    expect(after).not.toBe(first)
    expect(after).toBeLessThan(60_000)     // 落在新配音里，不是旧的
  })

  /*
   * 新配音短过旧边界时，排布那边 `hb < totalMs` 会判假 → 悄悄退回不定长，
   * 这条片子从此失去重选开头能力而没人知道。重算之后这种情况不可能出现。
   */
  it('新配音短过旧分界，也不会留下一个越界的分界', () => {
    const id = seed({ totalMs: 400_000 })
    settleAfterVoice(USER, LIST, id, dataDir)
    const db = openUserDb(USER, LIST)
    db.updateProject(id, { ttsDurationMs: 30_000, wordTimingsJson: JSON.stringify(words(30_000)) })
    db.close()
    settleAfterVoice(USER, LIST, id, dataDir)
    expect(read(id).headBoundaryMs!).toBeLessThan(30_000)
  })

  /*
   * 先做文本配音（边界已定）、后来改成自备音频（line）——
   * 自备那条路根本没有开头桶的概念，过期的边界必须清掉。
   */
  it('改成自备音频 → 分界写回 null', () => {
    const id = seed({ totalMs: 200_000 })
    settleAfterVoice(USER, LIST, id, dataDir)
    expect(read(id).headBoundaryMs).not.toBeNull()

    const db = openUserDb(USER, LIST)
    db.updateProject(id, { subtitleMode: 'line' })
    db.close()
    settleAfterVoice(USER, LIST, id, dataDir)
    expect(read(id).headBoundaryMs).toBeNull()
  })

  /*
   * 比例【只在第一次写】。定长开头下 ratio[0] 根本用不上（开头长度由分界
   * 直接给），真正起作用的只有常规:跑酷那一档——跟着重配音 churn 等于
   * 无缘无故换掉一条她可能已经认可的排布风格。
   */
  it('重新配音不会动已经定下来的比例', () => {
    const id = seed({ totalMs: 200_000 })
    const db = openUserDb(USER, LIST)
    db.updateProject(id, { layoutRatioJson: JSON.stringify([0.27, 0.27, 0.46]) })
    db.close()
    settleAfterVoice(USER, LIST, id, dataDir)
    expect(JSON.parse(read(id).layoutRatioJson!)).toEqual([0.27, 0.27, 0.46])
  })

  it('算不出分界（字幕太少）→ 写 null，不抛', () => {
    const db = openUserDb(USER, LIST)
    const p = db.createProject('太短')
    db.updateProject(p.id, {
      ttsState: 'ready', ttsDurationMs: 100_000,
      wordTimingsJson: JSON.stringify(words(2000)),   // 字幕只到 2 秒
    })
    db.close()
    expect(() => settleAfterVoice(USER, LIST, p.id, dataDir)).not.toThrow()
    expect(read(p.id).headBoundaryMs).toBeNull()
  })
})

describe('分界一变，已敲定的开头清单要跟着对齐', () => {
  /*
   * "挑够了吗"那道闸判的是边界，而边界是配音成功才有的——所以只要作者在
   * 配音出结果之前按了确认，那道闸就形同虚设。边界诞生的这一刻，
   * 正是唯一能把"她挑的"和"实际需要的"对齐的时机。
   */
  it('已 settled 但清单不够长 → 自动补齐到边界', () => {
    const id = seed({ totalMs: 400_000 })
    const db = openUserDb(USER, LIST)
    db.updateProject(id, {
      openingState: 'settled',
      openingPickJson: JSON.stringify(['1-开头/k0.mp4', '1-开头/k1.mp4']),   // 只有 20 秒
    })
    db.close()

    settleAfterVoice(USER, LIST, id, dataDir)
    const p = read(id)
    const pick = parseOpeningPick(p.openingPickJson)
    expect(pick.slice(0, 2)).toEqual(['1-开头/k0.mp4', '1-开头/k1.mp4'])   // 她挑的原样在前
    expect(pick.length * 10_000).toBeGreaterThanOrEqual(p.headBoundaryMs!)
  })

  /* 还停在 pending 的说明作者马上要去挑，替他填上等于抢答 */
  it('还没敲定（pending）的不碰', () => {
    const id = seed({ totalMs: 400_000 })
    const db = openUserDb(USER, LIST)
    db.updateProject(id, { openingState: 'pending', openingPickJson: JSON.stringify(['1-开头/k0.mp4']) })
    db.close()

    settleAfterVoice(USER, LIST, id, dataDir)
    expect(parseOpeningPick(read(id).openingPickJson)).toEqual(['1-开头/k0.mp4'])
  })

  it('清单本来就够长 → 一个都不加', () => {
    const id = seed({ totalMs: 200_000 })
    const enough = Array.from({ length: 12 }, (_, i) => `1-开头/k${i}.mp4`)   // 120 秒
    const db = openUserDb(USER, LIST)
    db.updateProject(id, { openingState: 'settled', openingPickJson: JSON.stringify(enough) })
    db.close()

    settleAfterVoice(USER, LIST, id, dataDir)
    expect(parseOpeningPick(read(id).openingPickJson)).toEqual(enough)
  })
})
