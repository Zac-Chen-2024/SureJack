import { describe, it, expect } from 'vitest'
import { headBoundary, HEAD_TARGET_RATIO } from '../../src/subtitles/head-boundary.js'
import type { SubtitleLine, WordTiming } from '../../src/types.js'

/**
 * 开头段边界。**这是「重选开头」整个功能的地基**：
 * 只要这个边界永远落在同一个时刻，后半段就能原样复用，
 * 重选开头只需重烧那一两分钟而不是整条 14 分钟。
 */

/** 造一条字幕行：只有起止时间是这组测试关心的 */
function line (startMs: number, endMs: number, text = '话'): SubtitleLine {
  const words: WordTiming[] = [
    { text, offsetMs: startMs, durationMs: endMs - startMs, isPunctuation: false },
  ]
  return { startMs, endMs, words }
}

/** 每句 1 秒、无缝相接的一串 */
function evenLines (n: number): SubtitleLine[] {
  return Array.from({ length: n }, (_, i) => line(i * 1000, (i + 1) * 1000))
}

describe('取大，不取近', () => {
  /*
   * ⚠️ 这一条是规则的核心。取最近的话可能落在目标【之前】那一句，
   * 开头就比预期短——而开头是留给观众建立第一印象的，短了不划算。
   */
  it('目标落在两句中间时，取后面那一句的句尾', () => {
    // 10 句 × 1 秒；比例 0.25 → 目标 2500ms，落在第 3 句(2000~3000)中间
    const b = headBoundary(evenLines(10), 10_000, 0.25)
    expect(b).not.toBeNull()
    expect(b!.endMs).toBe(3000)     // 取大：3000 而不是 2000
    expect(b!.lineIndex).toBe(2)
  })

  it('目标正好等于某一句的句尾时，就取那一句（不再往后跳）', () => {
    const b = headBoundary(evenLines(10), 10_000, 0.3)   // 目标 3000ms
    expect(b!.endMs).toBe(3000)
    expect(b!.lineIndex).toBe(2)
  })

  it('结果永远不短于目标', () => {
    for (const ratio of [0.1, 0.2, 0.27, 0.35, 0.5, 0.75]) {
      const total = 10_000
      const b = headBoundary(evenLines(10), total, ratio)
      if (b === null) continue
      expect(b.endMs).toBeGreaterThanOrEqual(total * ratio)
    }
  })
})

describe('确定性：同样的输入永远同样的输出', () => {
  /*
   * 后半段能被永久复用，靠的就是这一条。边界一旦漂移，
   * 盘上那份后半段就对不上新的时间轴了。
   */
  it('同一组输入连算十次结果完全一致', () => {
    const lines = evenLines(50)
    const first = headBoundary(lines, 50_000)
    for (let i = 0; i < 10; i++) {
      expect(headBoundary(lines, 50_000)).toEqual(first)
    }
  })

  it('句子长短不齐时也稳定', () => {
    const lines = [
      line(0, 1200), line(1200, 4500), line(4500, 4900),
      line(4900, 9100), line(9100, 9300), line(9300, 15_000),
    ]
    const b = headBoundary(lines, 15_000, 0.27)   // 目标 4050ms
    expect(b!.endMs).toBe(4500)                   // 取大 → 第 2 句句尾
    expect(b!.lineIndex).toBe(1)
    expect(headBoundary(lines, 15_000, 0.27)).toEqual(b)
  })
})

describe('算不出来时返回 null，绝不抛', () => {
  /*
   * ⚠️ 算不出边界只意味着"这条片子不支持重选开头"，
   * 不该让它连烧都烧不了。所有异常输入一律给 null。
   */
  it('没有字幕', () => {
    expect(headBoundary([], 10_000)).toBeNull()
  })

  it('没有配音时长', () => {
    expect(headBoundary(evenLines(10), 0)).toBeNull()
    expect(headBoundary(evenLines(10), Number.NaN)).toBeNull()
    expect(headBoundary(evenLines(10), -1)).toBeNull()
  })

  it('比例不合法', () => {
    const lines = evenLines(10)
    expect(headBoundary(lines, 10_000, 0)).toBeNull()
    expect(headBoundary(lines, 10_000, 1)).toBeNull()
    expect(headBoundary(lines, 10_000, Number.NaN)).toBeNull()
  })

  /*
   * 边界落在最后一句 = 后半段是空的。拼接毫无意义，
   * 而且会产出一个 0 秒的文件让 ffmpeg 报一堆看不懂的错。
   */
  it('边界会落在最后一句时，判定为不支持拆分', () => {
    expect(headBoundary(evenLines(3), 3000, 0.9)).toBeNull()
    expect(headBoundary([line(0, 5000)], 5000)).toBeNull()   // 只有一句
  })

  it('所有字幕都在目标之前结束（末尾一大段静音）', () => {
    // 字幕只到 2 秒，而配音有 100 秒 → 目标 27 秒，没有任何一句能到
    const lines = [line(0, 1000), line(1000, 2000)]
    expect(headBoundary(lines, 100_000)).toBeNull()
  })
})

describe('默认比例', () => {
  /*
   * 15%（2026-08-15 从 27% 调下来）。和排布的 DEFAULT_RATIO[0] 是同一个数，
   * 但【互相独立】——排布的比例以后可能因为素材结构再调，而边界一旦定了
   * 就再也不能动（动了后半段就复用不了）。
   *
   * ⚠️ 改这个数只影响以后新建的项目：每条片子的分界在配音完成那一刻
   * 算好写进 head_boundary_ms，之后一辈子用自己那一个。
   */
  it('是 15%', () => {
    expect(HEAD_TARGET_RATIO).toBe(0.15)
  })

  it('不传比例时就用它', () => {
    const lines = evenLines(100)
    expect(headBoundary(lines, 100_000)).toEqual(headBoundary(lines, 100_000, HEAD_TARGET_RATIO))
  })
})
