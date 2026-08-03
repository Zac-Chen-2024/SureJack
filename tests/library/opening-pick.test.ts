import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planProjectBackground, parseOpeningPick, openingIdsOf, OPENING_BUCKET,
  SEQUEL_OPENING_CLIPS,
} from '../../src/library/background.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'

/*
 * 造一个假素材库：开头 12 段各 20 秒、常规 6 段各 30 秒、跑酷 2 段各 20 分钟。
 * 数量比真库小，但三段式公式要的形状是一样的（开头/常规是短片、跑酷是长录屏）。
 */
let dir: string
let db: LibraryDb
const OPENINGS: string[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openpick-'))
  db = openLibraryDb(dir)
  const add = (bucket: string, filename: string, durationMs: number): string => {
    const id = `${bucket}/${filename}`
    db.raw.prepare(
      `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, bucket, filename, durationMs, 1000, '2026-08-01T00:00:00.000Z')
    return id
  }
  // 开头桶要够多，否则"剔除主片用过的"之后可能无段可用，测的就不是我们想测的
  for (let i = 0; i < 24; i++) OPENINGS.push(add(OPENING_BUCKET, `kai-${i}.mp4`, 20_000))
  for (let i = 0; i < 6; i++) add('2-常规', `chang-${i}.mp4`, 30_000)
  for (let i = 0; i < 2; i++) add('3-地铁跑酷', `pao-${i}.mp4`, 1_200_000)
})

afterAll(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('parseOpeningPick', () => {
  it('空串 = 没挑', () => {
    expect(parseOpeningPick('')).toEqual([])
  })

  /*
   * 坏数据一律当"没挑"，不抛异常——这一列只影响挑素材，
   * 为它抛异常会把整条烧录链路带崩，症状还离得很远。
   */
  it.each([['不是 JSON', '{{{'], ['不是数组', '{"a":1}'], ['数组里混了非字符串', '[1,"a",null]']])(
    '%s 也不炸', (_label, json) => {
      expect(() => parseOpeningPick(json)).not.toThrow()
    })

  it('数组里的非字符串被剔掉，字符串留下', () => {
    expect(parseOpeningPick('[1,"a",null,"b"]')).toEqual(['a', 'b'])
  })
})

describe('挑过的开头', () => {
  it('【没挑时逐字节等于从前】——老项目绝不重排', () => {
    const before = planProjectBackground(db, 'p1', 600_000)
    const after = planProjectBackground(db, 'p1', 600_000, { openingPick: [] })
    expect(after).toEqual(before)
  })

  it('挑了就按挑的顺序铺，不洗牌', () => {
    const pick = [OPENINGS[3]!, OPENINGS[0]!, OPENINGS[7]!]
    const plan = planProjectBackground(db, 'p1', 600_000, { openingPick: pick })
    // 开头段目标是总长的 27% = 162 秒，每段 20 秒 → 挑的 3 段全用上
    expect(openingIdsOf(plan).slice(0, 3)).toEqual(pick)
  })

  it('同一段可以重复挑（有的开头就是要连着用两次）', () => {
    const pick = [OPENINGS[2]!, OPENINGS[2]!, OPENINGS[5]!]
    const plan = planProjectBackground(db, 'p1', 600_000, { openingPick: pick })
    expect(openingIdsOf(plan).slice(0, 3)).toEqual(pick)
  })

  it('挑的清单里有不存在的 id 就跳过它，不炸', () => {
    const plan = planProjectBackground(db, 'p1', 600_000,
      { openingPick: ['查无此段', OPENINGS[1]!] })
    expect(openingIdsOf(plan)[0]).toBe(OPENINGS[1])
  })

  it('挑不满目标时长也能出排布——剩下的顺延给后面两段', () => {
    // 只挑 1 段 20 秒，开头段目标是 162 秒
    const plan = planProjectBackground(db, 'p1', 600_000, { openingPick: [OPENINGS[0]!] })
    expect(openingIdsOf(plan)).toEqual([OPENINGS[0]])
    // 总长仍然精确等于配音长度，一毫秒都不能少
    expect(plan.totalMs).toBe(600_000)
  })
})

describe('续集的开头不能和主片撞', () => {
  /*
   * 这条不是自动成立的：两集各用自己的项目 id 当种子，顺序确实不同，
   * 但都从同一个开头桶里抓——主片抓十几段、续集抓 5 段，
   * 按概率平均会撞上一段左右。用户要求两集开头不一样，所以靠显式剔除。
   */
  it('不剔除的话，两集确实会撞（这就是要修的问题）', () => {
    const main = new Set(openingIdsOf(planProjectBackground(db, '主片', 600_000)))
    const seq = openingIdsOf(planProjectBackground(db, '续集', 600_000, { sequel: true }))
    // 只断言"有可能撞"这件事的前提：两边抓的是同一个池子
    expect(seq.every((id) => OPENINGS.includes(id))).toBe(true)
    expect(main.size).toBeGreaterThan(0)
  })

  it('给了 excludeOpening，续集一段都不会用到主片的开头', () => {
    const main = openingIdsOf(planProjectBackground(db, '主片', 600_000))
    const seq = openingIdsOf(planProjectBackground(db, '续集', 600_000,
      { sequel: true, excludeOpening: main }))
    expect(seq.length).toBeGreaterThan(0)
    for (const id of seq) expect(main).not.toContain(id)
  })

  it('续集默认仍然只取 5 段开头，剩下全给跑酷', () => {
    const seq = planProjectBackground(db, '续集', 600_000, { sequel: true })
    expect(openingIdsOf(seq)).toHaveLength(SEQUEL_OPENING_CLIPS)
    expect(seq.segments.some((s) => s.bucket === '2-常规')).toBe(false)
  })

  it('续集【自己挑过】就按挑的来，不再砍成 5 段', () => {
    const pick = OPENINGS.slice(0, 7)
    const seq = planProjectBackground(db, '续集', 600_000, { sequel: true, openingPick: pick })
    expect(openingIdsOf(seq)).toEqual(pick)
  })
})
