import { describe, it, expect } from 'vitest'
import { segmentLines } from '../../src/subtitles/segment.js'
import type { WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs: number, isPunctuation = false): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation })

describe('segmentLines', () => {
  it('在标点处断行——Azure 单独触发标点事件，断句是白送的', () => {
    const words = [
      w('震惊', 0, 500),
      w('！', 500, 100, true),
      w('包子', 600, 400),
      w('。', 1000, 100, true),
    ]
    const lines = segmentLines(words, 14)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('震惊！')
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('包子。')
  })

  it('标点留在它所属的那一行末尾，不甩到下一行开头', () => {
    const lines = segmentLines([w('好', 0, 100), w('。', 100, 50, true), w('坏', 150, 100)], 14)
    expect(lines[0]!.words.at(-1)!.text).toBe('。')
    expect(lines[1]!.words[0]!.text).toBe('坏')
  })

  it('超过字数上限强制断行——竖屏一行放不下太多字', () => {
    const words = Array.from({ length: 10 }, (_, i) => w('包子', i * 100, 100))
    const lines = segmentLines(words, 6)   // 每行最多 6 字 = 3 个「包子」
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      const chars = line.words.reduce((n, x) => n + [...x.text].length, 0)
      expect(chars).toBeLessThanOrEqual(6)
    }
  })

  it('行的起止时间完全由时间戳推导——首词起点到末词终点', () => {
    const lines = segmentLines([w('老陈', 250, 500), w('。', 750, 100, true)], 14)
    expect(lines[0]!.startMs).toBe(250)
    expect(lines[0]!.endMs).toBe(850)   // 750 + 100
  })

  it('空输入返回空数组，不崩', () => {
    expect(segmentLines([], 14)).toEqual([])
  })

  it('没有标点的长文本也能靠字数上限断开，不会产出一行超长字幕', () => {
    const words = Array.from({ length: 20 }, (_, i) => w('字', i * 100, 100))
    const lines = segmentLines(words, 5)
    expect(lines).toHaveLength(4)
  })

  it('末尾没有标点时也要 flush，不丢最后一行', () => {
    const lines = segmentLines([w('包子', 0, 500)], 14)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.words[0]!.text).toBe('包子')
  })
})
