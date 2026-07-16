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
})
