import { describe, it, expect } from 'vitest'
import { estimateAudioMs, toWordTiming, synthesize } from '../../src/tts/azure.js'

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

describe('synthesize 的拦截阈值', () => {
  it('原始估算未超 10 分钟，但乘上保守系数后超过——应拒绝', () => {
    // 3000 字：estimateAudioMs = 3000*196 = 588,000ms < 600,000ms（10 分钟）
    // 但 588,000 * 1.15 = 676,200ms > 600,000ms —— 保守系数生效
    const text = '字'.repeat(3000)
    expect(estimateAudioMs(text.length)).toBeLessThan(10 * 60 * 1000)
    // 拦截发生在 new Promise 之前的 throw，不会真的发起网络请求，
    // 所以可以放心传假的 key/region。
    expect(() => synthesize({
      text, outPath: '/dev/null', key: 'fake-key', region: 'fake-region',
    })).toThrow()
  })
})
