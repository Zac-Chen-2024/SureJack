import { describe, it, expect } from 'vitest'
import { fillToTarget, type FillItem } from '../../src/library/auto-fill.js'

/*
 * 自动补满开头。开头段是"铺满就停"的——跨过边界那一段会被截短，
 * 所以补法不同观感差很多：最后一段只播 2 秒的话一晃而过，很碎。
 *
 * 规则（用户定的）：**先让超出最少**（最好一刀不切），超出一样多时**用更少的片子**。
 */

const pool = (...secs: number[]): FillItem[] =>
  secs.map((s, i) => ({ id: `c${i}-${s}s`, durationMs: s * 1000 }))

const secs = (r: FillItem[]): number[] => r.map((x) => x.durationMs / 1000)
const total = (r: FillItem[]): number => r.reduce((s, x) => s + x.durationMs, 0)

describe('用户给的那个例子', () => {
  /* "还剩 15 秒，宁愿选 7+9 而不选 7+6+5" */
  it('还差 15 秒、手上有 5/6/7/9 → 凑出正好 15，一刀不切', () => {
    const r = fillToTarget(pool(5, 6, 7, 9), 15_000)
    expect(total(r)).toBe(15_000)
    expect(secs(r).sort((a, b) => a - b)).toEqual([6, 9])
  })

  it('绝不会挑出 7+6+5 那种（最后一段只播 2 秒）', () => {
    const r = fillToTarget(pool(5, 6, 7, 9), 15_000)
    expect(r.length).toBeLessThanOrEqual(2)
  })
})

describe('先比超出，再比段数', () => {
  /*
   * ⚠️ 贪心("先拿能整段放下的最长的")会在这儿翻车：直接拿 16、切掉 1 秒，
   * 而 8+7 正好 15、一刀不切。既然要"尽可能不剪断"，就得真算最优。
   */
  it('宁可多用一段，也要凑到正好', () => {
    const r = fillToTarget(pool(16, 8, 7), 15_000)
    expect(total(r)).toBe(15_000)
    expect(secs(r).sort((a, b) => a - b)).toEqual([7, 8])
  })

  it('凑不到正好时，取超出最少的', () => {
    const r = fillToTarget(pool(20, 17, 30), 15_000)
    expect(secs(r)).toEqual([17])          // 超 2 秒，比 20（超 5）和 30（超 15）都好
  })

  it('超出一样多时用更少的段', () => {
    // 目标 10：可选 12（超2，1段）或 6+6（正好，2段）——正好优先
    expect(total(fillToTarget(pool(12, 6, 6), 10_000))).toBe(12_000)
  })
})

describe('最长的排最后', () => {
  /*
   * 被截短的永远是最后一段（开头段铺满就停）。把它落在最长的那一段上，
   * 切掉的比例最小，最不像"被砍了一刀"。
   */
  it('返回的顺序里最长的在末尾', () => {
    const r = fillToTarget(pool(6, 9, 12, 20), 26_000)
    const d = secs(r)
    expect(d[d.length - 1]).toBe(Math.max(...d))
  })
})

describe('填不满 / 边界情况', () => {
  it('素材加起来都不够 → 给出能给的最多的一组，不抛', () => {
    const r = fillToTarget(pool(5, 6), 100_000)
    expect(total(r)).toBe(11_000)
  })

  it('目标是 0 或负数 → 什么都不选', () => {
    expect(fillToTarget(pool(5, 6), 0)).toEqual([])
    expect(fillToTarget(pool(5, 6), -1)).toEqual([])
    expect(fillToTarget(pool(5, 6), Number.NaN)).toEqual([])
  })

  it('没有候选 → 空数组', () => {
    expect(fillToTarget([], 15_000)).toEqual([])
  })

  it('时长非法的候选直接跳过', () => {
    const r = fillToTarget([{ id: 'bad', durationMs: 0 }, { id: 'ok', durationMs: 20_000 }], 15_000)
    expect(r.map((x) => x.id)).toEqual(['ok'])
  })

  /* 同一段素材不能用两次——0/1 背包，不是完全背包 */
  it('一段素材只用一次', () => {
    const r = fillToTarget(pool(8), 30_000)
    expect(r.map((x) => x.id)).toEqual(['c0-8s'])
  })
})

describe('真实规模跑得动', () => {
  it('68 段素材、还差 90 秒，算得出来且够长', () => {
    const lib = pool(...Array.from({ length: 68 }, (_, i) => 5 + (i * 7) % 24))
    const t0 = Date.now()
    const r = fillToTarget(lib, 90_000)
    expect(total(r)).toBeGreaterThanOrEqual(90_000)
    expect(Date.now() - t0).toBeLessThan(200)
    // id 不重复
    expect(new Set(r.map((x) => x.id)).size).toBe(r.length)
  })
})
