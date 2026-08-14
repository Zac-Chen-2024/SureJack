import { describe, it, expect } from 'vitest'
import {
  AZURE_VOICE_LUFS, DEFAULT_VOICE_GAIN, recommendVoiceGain, recommendBgmVolume,
} from '../../src/audio/analyze.js'
import { TARGET_LUFS } from '../../src/compose/mix.js'

/**
 * 【默认配音增益 = 推荐值】。
 *
 * 依据是实测：Azure TTS 自带响度归一化——两条毫不相干的配音，
 * 一条 6 秒、一条 9 分 24 秒（长度差 90 倍），响度分别是 -20.4 和 -21.3 LUFS，
 * 只差 0.9 LU。所以"推到平台惯用的 -14"是个算得出来的定值，
 * 不该让每个用户自己拖滑块摸索。
 */
describe('默认配音增益', () => {
  it('照这个增益，配音正好落在平台惯用响度上', () => {
    const after = AZURE_VOICE_LUFS + 20 * Math.log10(DEFAULT_VOICE_GAIN)
    expect(Math.abs(after - TARGET_LUFS)).toBeLessThan(0.1)
  })

  it('默认值就是推荐值本身——两者不能各算各的', () => {
    expect(DEFAULT_VOICE_GAIN).toBe(recommendVoiceGain(AZURE_VOICE_LUFS))
  })

  /*
   * 实测的两条真实配音各自算出来的推荐值。其中 -20.4 那条算出 2.09，
   * 而那个用户【手动拖到的正好也是 2.09】——公式给的就是人耳想要的数。
   */
  it('对实测过的两条真实配音，推荐值落在合理区间', () => {
    expect(recommendVoiceGain(-20.4)).toBe(2.09)
    expect(recommendVoiceGain(-21.3)).toBe(2.32)
  })

  it('拿不到响度时退回原样，绝不瞎放大', () => {
    expect(recommendVoiceGain(Number.NaN)).toBe(1)
  })

  /*
   * ⚠️【音乐不能有固定默认值】。曲库那 9 首实测极差 7.1 LU
   * （-11.4 ~ -18.5），是配音那 0.9 LU 的八倍——同一个 bgmVolume
   * 用在最响和最轻的曲子上，一个会盖住人声，一个几乎听不见。
   */
  it('音乐的推荐音量必须跟着曲子走，不是常数', () => {
    const loud = recommendBgmVolume(-20.8, -11.4)
    const quiet = recommendBgmVolume(-20.8, -18.5)
    expect(loud).not.toBe(quiet)
    expect(quiet).toBeGreaterThan(loud)
  })
})
