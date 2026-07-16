import { describe, it, expect } from 'vitest'
import { unescapeXml, normalizeScript } from '../../src/importers/sanitize.js'

describe('unescapeXml', () => {
  it('还原 Azure WordBoundary 返回的转义实体', () => {
    // 实测：输入 A&B，Azure 事件的 text 回来是 &amp; 而非 &
    expect(unescapeXml('&amp;')).toBe('&')
    expect(unescapeXml('&lt;')).toBe('<')
    expect(unescapeXml('&gt;')).toBe('>')
    expect(unescapeXml('&quot;')).toBe('"')
    expect(unescapeXml('&apos;')).toBe("'")
  })

  it('不碰普通文本', () => {
    expect(unescapeXml('震惊！这个方法')).toBe('震惊！这个方法')
  })

  it('&amp;amp; 只还原一层，不重复解码', () => {
    // 重复解码会把 &amp;lt; 变成 <，那是注入风险
    expect(unescapeXml('&amp;amp;')).toBe('&amp;')
  })
})

describe('normalizeScript', () => {
  it('把连续空白压成单空格，保留标点', () => {
    expect(normalizeScript('老陈是在星期八醒来的。\n\n他决定去买包子。'))
      .toBe('老陈是在星期八醒来的。 他决定去买包子。')
  })

  it('去掉首尾空白', () => {
    expect(normalizeScript('  包子  ')).toBe('包子')
  })
})
