import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import iconv from 'iconv-lite'
import { importScript } from '../../src/importers/index.js'

describe('importScript', () => {
  it('按扩展名分发 .txt，并正确处理 GBK', () => {
    const text = '震惊！这个方法99%的人都不知道，AI一秒搞定。'
    writeFileSync('/tmp/t.txt', iconv.encode(text, 'gbk'))
    return expect(importScript('/tmp/t.txt')).resolves.toBe(text)
  })

  it('拒绝不支持的格式，并说明支持哪些', async () => {
    writeFileSync('/tmp/t.pdf', 'x')
    await expect(importScript('/tmp/t.pdf')).rejects.toThrow(/不支持.*pdf/)
  })
})
