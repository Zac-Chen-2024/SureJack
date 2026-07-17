import { describe, it, expect } from 'vitest'
import { unescapeXml, normalizeScript, stripBom, looksLikeMojibake } from '../../src/importers/sanitize.js'

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

describe('stripBom', () => {
  it('剥掉开头的 UTF-8 BOM', () => {
    expect(stripBom('﻿包子')).toBe('包子')
    expect(stripBom('﻿包子').charCodeAt(0)).not.toBe(0xfeff)
  })

  it('没有 BOM 时原样返回', () => {
    expect(stripBom('包子')).toBe('包子')
  })

  it('只剥开头，不碰文本中间出现的 U+FEFF', () => {
    expect(stripBom('包﻿子')).toBe('包﻿子')
  })
})

// looksLikeMojibake 的判据本身在 tests/importers/doc.test.ts 里已经覆盖
// （它是这个函数唯一的原始调用方，搬到这里后行为不变，见 I6/I2）。
// 这里只做基本行为验证，确认 txt.ts 和 doc.ts 现在共用同一份实现，避免两份实现分裂。
describe('looksLikeMojibake（从 doc.ts 提取到这里，供 doc.ts 和 txt.ts 共用）', () => {
  it('正常中文不是乱码', () => {
    expect(looksLikeMojibake('震惊！这个方法99%的人都不知道')).toBe(false)
  })

  it('识别 UTF-8 被当 cp1252 读出来的乱码', () => {
    expect(looksLikeMojibake('è¿™ä¸æ˜¯ä¸€ä¸ªçœŸæ£çš„ doc æ–‡ä»¶')).toBe(true)
  })
})
