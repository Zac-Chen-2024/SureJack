import { describe, it, expect } from 'vitest'
import { looksLikeMojibake } from '../../src/importers/doc.js'

describe('looksLikeMojibake', () => {
  it('正常中文不是乱码', () => {
    expect(looksLikeMojibake('震惊！这个方法99%的人都不知道')).toBe(false)
  })

  it('正常英文不是乱码', () => {
    expect(looksLikeMojibake('This is a normal English sentence.')).toBe(false)
  })

  it('识别 UTF-8 被当 cp1252 读出来的乱码', () => {
    // 这是 catdoc 静默失败时的实际输出形态（阶段 0 实测）
    expect(looksLikeMojibake('è¿™ä¸æ˜¯ä¸€ä¸ªçœŸæ£çš„ doc æ–‡ä»¶')).toBe(true)
  })

  it('识别 GBK 被当 latin1 读出来的乱码', () => {
    expect(looksLikeMojibake('Õð¾ª£¡Õâ¸ö·½·¨99%µÄÈË¶¼²»ÖªµÀ')).toBe(true)
  })

  it('空字符串算失败', () => {
    expect(looksLikeMojibake('')).toBe(true)
  })

  it('少量重音字母不误判——法语人名不该被当成乱码', () => {
    expect(looksLikeMojibake('André 是一个法国人的名字，他今天来买包子。')).toBe(false)
  })
})
