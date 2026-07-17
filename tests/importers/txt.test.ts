import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { importTxt } from '../../src/importers/txt.js'

const CN = '震惊！这个方法99%的人都不知道，AI一秒搞定。'

describe('importTxt', () => {
  it('读 UTF-8', () => {
    const r = importTxt(Buffer.from(CN, 'utf-8'))
    expect(r.text).toBe(CN)
  })

  it('读 GBK——中文 txt 的常见编码，按 UTF-8 硬读会乱码', () => {
    const r = importTxt(iconv.encode(CN, 'gbk'))
    expect(r.text).toBe(CN)
  })

  it('读 GB18030', () => {
    const r = importTxt(iconv.encode(CN, 'gb18030'))
    expect(r.text).toBe(CN)
  })

  it('剥掉 UTF-8 BOM——Windows 记事本会加，不剥的话首字符是不可见的 \\uFEFF', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CN, 'utf-8')])
    expect(importTxt(withBom).text).toBe(CN)
  })

  it('报告探测到的编码与置信度', () => {
    const r = importTxt(iconv.encode(CN, 'gbk'))
    expect(r.encoding.toLowerCase()).toMatch(/gb/)
    expect(r.confidence).toBeGreaterThan(0)
  })

  it('空文件抛错——不能让空字符串静默流进 TTS（I2）', () => {
    expect(() => importTxt(Buffer.alloc(0))).toThrow(/空/)
  })

  it('只有空白字符的文件也算空文本，抛错', () => {
    expect(() => importTxt(Buffer.from('   \n\n  \t  ', 'utf-8'))).toThrow(/空/)
  })

  it('乱码内容抛错，不静默放行（I2，复用 looksLikeMojibake）', () => {
    // 与 doc.test.ts 用的是同一份已验证的乱码样本（UTF-8 被当 cp1252 读出来的形态）
    const mojibake = 'è¿™ä¸æ˜¯ä¸€ä¸ªçœŸæ£çš„ txt æ–‡ä»¶'
    expect(() => importTxt(Buffer.from(mojibake, 'utf-8'))).toThrow(/乱码/)
  })
})
