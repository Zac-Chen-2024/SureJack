import { describe, it, expect } from 'vitest'
import {
  VOICES, DEFAULT_VOICE, LEGACY_VOICE, LEGACY_PARAMS, DEFAULT_VOICE_RATE,
  isAllowedVoice, clampRate, clampVolume, clampPitch, isLegacyParams, pct,
  RATE_RANGE, VOLUME_RANGE, PITCH_RANGE,
} from '../../src/tts/voices.js'
// 前端各存一份，这里把两边钉死
import {
  VOICES as FE_VOICES, RATE_RANGE as FE_RATE, DEFAULT_VOICE_RATE as FE_DEF_RATE,
  VOLUME_RANGE as FE_VOL, PITCH_RANGE as FE_PITCH,
} from '../../web/src/store/projects.js'

describe('音色清单', () => {
  it('默认是晓辰，老默认是晓晓（两者必须不同，否则新老无从区分）', () => {
    expect(DEFAULT_VOICE).toBe('zh-CN-XiaochenNeural')
    expect(LEGACY_VOICE).toBe('zh-CN-XiaoxiaoNeural')
    expect(DEFAULT_VOICE).not.toBe(LEGACY_VOICE)
    // 新项目默认语速是 75，但中性/老默认仍是 0（指纹 carve-out 靠它）
    expect(DEFAULT_VOICE_RATE).toBe(75)
    expect(LEGACY_PARAMS.rate).toBe(0)
    expect(FE_DEF_RATE).toBe(DEFAULT_VOICE_RATE)
  })

  it('默认音色在清单里', () => {
    expect(isAllowedVoice(DEFAULT_VOICE)).toBe(true)
  })

  it('清单里的 id 都是 zh-CN-*Neural 格式（拼错会让合成直接失败）', () => {
    for (const v of VOICES) expect(v.id).toMatch(/^zh-CN-\w+Neural$/)
  })

  /*
   * 前端不能 import 后端，只能各存一份配音清单。这条测试就是那份「合同」：
   * 加/删音色、改范围时两边必须一起动，否则用户在前端选的音色后端不认、
   * 或滑块能拖到后端会钳掉的值。
   */
  it('【前后端清单逐条一致】这是前后端各存一份的唯一保障', () => {
    expect(FE_VOICES.map((v) => v.id)).toEqual(VOICES.map((v) => v.id))
    expect(FE_VOICES.map((v) => v.label)).toEqual(VOICES.map((v) => v.label))
    expect(FE_RATE).toEqual(RATE_RANGE)
    expect(FE_VOL).toEqual(VOLUME_RANGE)
    expect(FE_PITCH).toEqual(PITCH_RANGE)
  })
})

describe('校验与钳位', () => {
  it('不在清单里的音色一律拒', () => {
    expect(isAllowedVoice('zh-CN-XiaoxuanNeural')).toBe(false)  // 这个真不存在
    expect(isAllowedVoice('')).toBe(false)
    expect(isAllowedVoice(123)).toBe(false)
    expect(isAllowedVoice(null)).toBe(false)
  })

  it('韵律钳到范围，脏值回落默认', () => {
    expect(clampRate(999)).toBe(RATE_RANGE.max)
    expect(clampRate(-999)).toBe(RATE_RANGE.min)
    expect(clampRate(NaN)).toBe(RATE_RANGE.default)
    expect(clampRate('30')).toBe(30)
    expect(clampVolume(999)).toBe(VOLUME_RANGE.max)
    expect(clampPitch(-999)).toBe(PITCH_RANGE.min)
  })
})

describe('老默认判定（母带指纹据此决定重不重烧）', () => {
  it('晓晓+中性 = 老默认', () => {
    expect(isLegacyParams(LEGACY_PARAMS)).toBe(true)
  })
  it('换了音色就不是老默认', () => {
    expect(isLegacyParams({ ...LEGACY_PARAMS, voice: DEFAULT_VOICE })).toBe(false)
  })
  it('任一韵律非 0 就不是老默认', () => {
    expect(isLegacyParams({ ...LEGACY_PARAMS, rate: 10 })).toBe(false)
    expect(isLegacyParams({ ...LEGACY_PARAMS, volume: -5 })).toBe(false)
    expect(isLegacyParams({ ...LEGACY_PARAMS, pitch: 5 })).toBe(false)
  })
})

describe('SSML 百分比格式', () => {
  it('正数带 +，负数带 -，0 是 +0%', () => {
    expect(pct(30)).toBe('+30%')
    expect(pct(-10)).toBe('-10%')
    expect(pct(0)).toBe('+0%')
  })
})
