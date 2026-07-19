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

/*
 * 原本这里有一组「synthesize 的拦截阈值」测试，断言超长文案会被
 * synthesize 当场 throw。Task 4 把那道拦截移到了 synthesizeLong ——
 * 超长文案现在由 splitScript 切开后逐段合成，不再拒绝，所以那组
 * 测试连同 REJECTION_SAFETY_MARGIN 一起删除。
 *
 * 替代覆盖在 tests/tts/long.test.ts：长文案会被切成多段各自合成。
 *
 * 注意：拦截删掉后，那个测试传的 fake-key 不再被提前拦下，
 * 会真的发起一次 Azure 请求——留着它不只是红，还会打网络。
 */
