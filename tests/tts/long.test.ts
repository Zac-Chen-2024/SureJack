import { describe, it, expect } from 'vitest'
import { shiftWords } from '../../src/tts/long.js'
import type { WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs = 300): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation: false })

describe('shiftWords', () => {
  it('平移只改 offsetMs，不改 durationMs', () => {
    const out = shiftWords([w('他', 0, 250), w('决定', 300, 400)], 5000)
    expect(out.map((x) => x.offsetMs)).toEqual([5000, 5300])
    expect(out.map((x) => x.durationMs)).toEqual([250, 400])
  })

  it('偏移 0 时原样返回', () => {
    expect(shiftWords([w('他', 120)], 0)).toEqual([w('他', 120)])
  })

  /*
   * 返回新数组：调用方可能还要用原始的段内时间轴排查问题。
   *
   * 下面用 toMatchObject 断言整个元素，而不是 orig[0]!.offsetMs 逐字段取。
   * tsconfig 开了 noUncheckedIndexedAccess，索引结果是 T | undefined，
   * 逐字段取要么加 ! 断言（等于关掉这道检查），要么整体比对——后者更好，
   * 因为它顺带把「其他字段没被动过」也一起断言了。
   */
  it('不修改入参数组', () => {
    const orig = [w('他', 100)]
    shiftWords(orig, 5000)
    expect(orig).toEqual([w('他', 100)])
  })

  it('文字与标点标记原样保留', () => {
    const src: WordTiming[] = [{ text: '。', offsetMs: 0, durationMs: 100, isPunctuation: true }]
    expect(shiftWords(src, 1000)).toEqual([
      { text: '。', offsetMs: 1000, durationMs: 100, isPunctuation: true },
    ])
  })
})
