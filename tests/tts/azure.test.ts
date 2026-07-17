import { describe, it, expect } from 'vitest'
import { estimateAudioMs, toWordTiming } from '../../src/tts/azure.js'

describe('toWordTiming', () => {
  it('audioOffset 是 100 纳秒单位，除以 10000 得毫秒', () => {
    const r = toWordTiming({ text: '震惊', audioOffset: 5000000, duration: 5880000, boundaryType: 'WordBoundary' })
    expect(r.offsetMs).toBe(500)
    expect(r.durationMs).toBe(588)
  })

  it('反转义 XML 实体——Azure 返回的是转义后的形态', () => {
    const r = toWordTiming({ text: '&amp;', audioOffset: 0, duration: 0, boundaryType: 'WordBoundary' })
    expect(r.text).toBe('&')
  })

  it('识别标点事件', () => {
    const r = toWordTiming({ text: '！', audioOffset: 0, duration: 0, boundaryType: 'PunctuationBoundary' })
    expect(r.isPunctuation).toBe(true)
  })

  it('词事件不是标点', () => {
    const r = toWordTiming({ text: '包子', audioOffset: 0, duration: 0, boundaryType: 'WordBoundary' })
    expect(r.isPunctuation).toBe(false)
  })
})

describe('estimateAudioMs', () => {
  it('估算用于提交前拦截超长文案', () => {
    // 实测：937 字 → 184.2 秒，约 196ms/字
    expect(estimateAudioMs(937)).toBeGreaterThan(150000)
    expect(estimateAudioMs(937)).toBeLessThan(220000)
  })
})
