import { describe, it, expect } from 'vitest'
import { buildSsml, estimateAudioMs, maxCharsForMs, rateFactor } from '../../src/tts/azure.js'
import { splitScript } from '../../src/tts/split.js'

describe('SSML 构造', () => {
  it('音色和韵律都进了 <voice>/<prosody>', () => {
    const s = buildSsml({ text: '你好', voice: 'zh-CN-XiaochenNeural', rate: 30, volume: -10, pitch: 5 })
    expect(s).toContain('<voice name="zh-CN-XiaochenNeural">')
    expect(s).toContain('rate="+30%"')
    expect(s).toContain('volume="-10%"')
    expect(s).toContain('pitch="+5%"')
    expect(s).toContain('你好')
  })

  /*
   * 正文里的 & < > 不转义会让整段 SSML 解析失败或吞字——文案里出现
   * "A&B"、"<3" 这类完全正常。这条测试守住转义。
   */
  it('【正文必须 XML 转义】否则含 & < > 的文案会炸', () => {
    const s = buildSsml({ text: 'A&B <3 >_>', voice: 'zh-CN-XiaochenNeural', rate: 0, volume: 0, pitch: 0 })
    expect(s).toContain('A&amp;B &lt;3 &gt;_&gt;')
    expect(s).not.toContain('A&B')          // 裸 & 绝不能出现在正文里
  })
})

describe('语速影响时长估算', () => {
  it('调快 → 每字变短；调慢 → 变长', () => {
    expect(rateFactor(0)).toBe(1)
    expect(estimateAudioMs(100, 100)).toBeCloseTo(estimateAudioMs(100, 0) / 2)   // 快一倍
    expect(estimateAudioMs(100, -50)).toBeCloseTo(estimateAudioMs(100, 0) * 2)   // 慢一半
  })

  it('maxCharsForMs 跟着反向变：慢语速下同样预算放更少字', () => {
    expect(maxCharsForMs(60_000, -50)).toBeLessThan(maxCharsForMs(60_000, 0))
  })

  /*
   * 关键正确性：调慢语速时，切段必须按【放大后】的估算切，否则某段真到
   * Azure 才发现超 10 分钟上限而失败。构造一段在正常语速下切成 1 段、
   * 但慢速下应该切成多段的文本。
   */
  it('【慢语速要切得更碎】否则撞 Azure 10 分钟硬上限', () => {
    // 每字约 196ms，8 分钟目标约放 2448 字。造 3000 字（正常语速也要切，
    // 但慢速下段数必须更多）
    const text = '这是一句测试文案。'.repeat(400)   // 约 3600 字，含句末标点
    const normal = splitScript(text, undefined, 0)
    const slow = splitScript(text, undefined, -50)  // 慢一半 → 实际时长翻倍
    expect(slow.length).toBeGreaterThan(normal.length)
  })
})
