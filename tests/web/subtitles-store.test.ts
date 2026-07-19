import { describe, it, expect, beforeEach } from 'vitest'
import {
  formatTimestamp, findCurrentLineIndex, lineText, useSubtitles,
  type SubtitleLine,
} from '../../web/src/store/subtitles'

function line (startMs: number, endMs: number, text = '词'): SubtitleLine {
  return {
    startMs, endMs,
    words: [{ text, offsetMs: startMs, durationMs: endMs - startMs, isPunctuation: false }],
  }
}

describe('formatTimestamp', () => {
  it('格式是 m:ss.s', () => {
    expect(formatTimestamp(0)).toBe('0:00.0')
    expect(formatTimestamp(1234)).toBe('0:01.2')
    expect(formatTimestamp(65_400)).toBe('1:05.4')
    expect(formatTimestamp(600_000)).toBe('10:00.0')
  })

  it('秒位补零，保证一列时间戳等宽（配 tabular-nums 才对得齐）', () => {
    expect(formatTimestamp(5_000)).toBe('0:05.0')
    expect(formatTimestamp(59_900)).toBe('0:59.9')
  })

  it('截断而非四舍五入——59.96 秒不能显示成 0:60.0', () => {
    expect(formatTimestamp(59_960)).toBe('0:59.9')
    expect(formatTimestamp(59_999)).toBe('0:59.9')
    expect(formatTimestamp(60_000)).toBe('1:00.0')
  })

  it('负数和非法值钳到 0，不把整列排版撑坏', () => {
    expect(formatTimestamp(-500)).toBe('0:00.0')
    expect(formatTimestamp(NaN)).toBe('0:00.0')
    expect(formatTimestamp(Infinity)).toBe('0:00.0')
  })
})

describe('findCurrentLineIndex', () => {
  const lines = [line(0, 1000), line(1000, 2000), line(5000, 6000)]

  it('空列表返回 -1', () => {
    expect(findCurrentLineIndex([], 100)).toBe(-1)
  })

  it('第一行开始之前返回 -1', () => {
    expect(findCurrentLineIndex([line(500, 1000)], 100)).toBe(-1)
  })

  it('落在某行区间内时命中该行', () => {
    expect(findCurrentLineIndex(lines, 0)).toBe(0)
    expect(findCurrentLineIndex(lines, 999)).toBe(0)
    expect(findCurrentLineIndex(lines, 1000)).toBe(1)
    expect(findCurrentLineIndex(lines, 5500)).toBe(2)
  })

  it('落在行间停顿里时保持在上一行，不让高亮闪没', () => {
    expect(findCurrentLineIndex(lines, 3000)).toBe(1)
  })

  it('超过最后一行末尾时停在最后一行', () => {
    expect(findCurrentLineIndex(lines, 999_999)).toBe(2)
  })

  it('几百行时二分查找结果与线性扫描一致', () => {
    const many = Array.from({ length: 500 }, (_, i) => line(i * 100, i * 100 + 80))
    for (const ms of [0, 55, 100, 12_345, 49_999, 50_000]) {
      let expected = -1
      many.forEach((l, i) => { if (l.startMs <= ms) expected = i })
      expect(findCurrentLineIndex(many, ms)).toBe(expected)
    }
  })
})

describe('lineText', () => {
  it('把词顺序拼回可读文本（标点本身也是词）', () => {
    expect(lineText({
      startMs: 0, endMs: 900,
      words: [
        { text: '今天', offsetMs: 0, durationMs: 400, isPunctuation: false },
        { text: '很好', offsetMs: 400, durationMs: 400, isPunctuation: false },
        { text: '。', offsetMs: 800, durationMs: 100, isPunctuation: true },
      ],
    })).toBe('今天很好。')
  })
})

describe('useSubtitles 的跳转状态', () => {
  beforeEach(() => { useSubtitles.getState().reset() })

  it('seekTo 更新 currentMs 并递增 seekNonce（播放器靠它区分跳转和自然播放）', () => {
    const { seekTo } = useSubtitles.getState()
    expect(useSubtitles.getState().seekNonce).toBe(0)
    seekTo(4200)
    expect(useSubtitles.getState().currentMs).toBe(4200)
    expect(useSubtitles.getState().seekNonce).toBe(1)
  })

  it('连续跳到同一个时间点，seekNonce 仍然递增', () => {
    const { seekTo } = useSubtitles.getState()
    seekTo(1000)
    seekTo(1000)
    expect(useSubtitles.getState().seekNonce).toBe(2)
  })

  it('setCurrentMs 只推进时间，不触发跳转', () => {
    useSubtitles.getState().setCurrentMs(300)
    expect(useSubtitles.getState().currentMs).toBe(300)
    expect(useSubtitles.getState().seekNonce).toBe(0)
  })

  it('负数时间钳到 0', () => {
    useSubtitles.getState().seekTo(-10)
    expect(useSubtitles.getState().currentMs).toBe(0)
  })

  it('reset 清空所有状态', () => {
    useSubtitles.setState({ lines: [line(0, 100)], error: 'x' })
    useSubtitles.getState().seekTo(500)
    useSubtitles.getState().reset()
    expect(useSubtitles.getState()).toMatchObject({
      lines: [], currentMs: 0, seekNonce: 0, loading: false, error: null,
    })
  })
})
