import { describe, it, expect } from 'vitest'
import { formatAssTime, buildKaraoke, buildAss } from '../../src/subtitles/ass.js'
import { ASPECT_PRESETS, FONT_FAMILY } from '../../src/config.js'
import type { SubtitleLine, WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs: number, isPunctuation = false): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation })

describe('formatAssTime', () => {
  it('格式是 H:MM:SS.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(1500)).toBe('0:00:01.50')
    expect(formatAssTime(61230)).toBe('0:01:01.23')
    expect(formatAssTime(3661000)).toBe('1:01:01.00')
  })

  it('负数夹到 0，不产出非法时间码', () => {
    expect(formatAssTime(-100)).toBe('0:00:00.00')
  })
})

describe('buildKaraoke', () => {
  it('\\kf 时长覆盖到下一个词的起点，不是本词 duration', () => {
    // 关键：词之间有空隙。若用本词 duration，扫光会在空隙处停顿、与音频脱节。
    const line: SubtitleLine = {
      startMs: 0, endMs: 1000,
      words: [w('震惊', 0, 400), w('包子', 500, 500)],
    }
    // 第一个词：500-0 = 500ms = 50cs（覆盖了 100ms 空隙），不是 40cs
    expect(buildKaraoke(line)).toBe('{\\kf50}震惊{\\kf50}包子')
  })

  it('最后一个词用自己的 duration', () => {
    const line: SubtitleLine = { startMs: 0, endMs: 400, words: [w('包子', 0, 400)] }
    expect(buildKaraoke(line)).toBe('{\\kf40}包子')
  })

  it('按词分组，不按字——Azure 给的是词级时间戳', () => {
    const line: SubtitleLine = { startMs: 0, endMs: 500, words: [w('震惊', 0, 500)] }
    // 「震惊」整体一个 \kf，不是 {\kf25}震{\kf25}惊
    expect(buildKaraoke(line)).toBe('{\\kf50}震惊')
  })
})

describe('buildAss', () => {
  const aspect = ASPECT_PRESETS['9:16']!
  const lines: SubtitleLine[] = [{ startMs: 0, endMs: 500, words: [w('包子', 0, 500)] }]

  it('PlayRes 必须等于输出分辨率，否则预览与成片会漂移', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
  })

  it('用正确的字体族名', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain(FONT_FAMILY)
    expect(ass).not.toMatch(/Noto Sans SC,/)   // 那个族名不存在，会静默回退
  })

  it('WrapStyle 是 2——禁用自动换行，绕开 libass 的中文换行问题', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('WrapStyle: 2')
  })

  it('karaoke 模式产出 \\kf 标签', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('{\\kf50}包子')
  })

  it('line 模式不产出 \\kf，只有纯文本', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'line' })
    expect(ass).not.toContain('\\kf')
    expect(ass).toContain(',,包子')
  })

  it('startMs 为 null 的文本层常驻全程——0 到片尾', () => {
    const ass = buildAss({
      lines, overlays: [{ content: '包子', style: 'Title', startMs: null, endMs: null }],
      aspect, durationMs: 184200, mode: 'karaoke',
    })
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:03:04.20,Title,,0,0,0,,包子')
  })

  it('文本层的 Layer 高于字幕，不会被字幕盖住', () => {
    const ass = buildAss({
      lines, overlays: [{ content: '免责', style: 'Disclaimer', startMs: null, endMs: null }],
      aspect, durationMs: 1000, mode: 'karaoke',
    })
    expect(ass).toMatch(/Dialogue: 1,.*Disclaimer/)   // 文本层 Layer 1
    expect(ass).toMatch(/Dialogue: 0,.*Sub/)          // 字幕 Layer 0
  })
})
