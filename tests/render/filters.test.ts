import { describe, it, expect } from 'vitest'
import { buildFitFilter, buildAudioFilter } from '../../src/render/filters.js'
import { ASPECT_PRESETS } from '../../src/config.js'
import type { Clip } from '../../src/types.js'

const aspect = ASPECT_PRESETS['9:16']!
const clip = (over: Partial<Clip> = {}): Clip => ({
  path: '/tmp/v.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5, ...over,
})

describe('buildFitFilter', () => {
  it('cover 模式：放大到铺满再裁切', () => {
    const f = buildFitFilter(clip(), aspect, '0:v', 'out')
    expect(f).toContain('force_original_aspect_ratio=increase')
    expect(f).toContain('crop=1080:1920')
  })

  it('cover 模式的偏移量：0.5 居中', () => {
    const f = buildFitFilter(clip({ cropOffsetX: 0.5, cropOffsetY: 0.5 }), aspect, '0:v', 'out')
    expect(f).toContain('(iw-ow)*0.5')
    expect(f).toContain('(ih-oh)*0.5')
  })

  it('cover 模式的偏移量：0 靠左上', () => {
    const f = buildFitFilter(clip({ cropOffsetX: 0, cropOffsetY: 0 }), aspect, '0:v', 'out')
    expect(f).toContain('(iw-ow)*0')
  })

  it('contain 模式：完整保留 + 黑边，不裁切', () => {
    const f = buildFitFilter(clip({ fitMode: 'contain' }), aspect, '0:v', 'out')
    expect(f).toContain('force_original_aspect_ratio=decrease')
    expect(f).toContain('pad=1080:1920')
    expect(f).not.toContain('crop=1080:1920')
  })

  it('blur 模式：分流做模糊底 + 前景叠加', () => {
    const f = buildFitFilter(clip({ fitMode: 'blur' }), aspect, '0:v', 'out')
    expect(f).toContain('split=2')
    expect(f).toContain('gblur')
    expect(f).toContain('overlay')
  })

  it('blur 模式先缩小再模糊——直接对 1080x1920 做大 sigma 模糊会慢得离谱', () => {
    const f = buildFitFilter(clip({ fitMode: 'blur' }), aspect, '0:v', 'out')
    // 先 scale 到小尺寸，模糊后再放大——模糊本身掩盖了放大的损失
    expect(f).toMatch(/scale=\d{2,3}:\d{2,3}[^;]*gblur/)
  })

  it('sourceCrop 生效——用于切掉源视频里烧死的字幕', () => {
    const f = buildFitFilter(
      clip({ sourceCrop: { w: 1052, h: 470, x: 0, y: 0 } }), aspect, '0:v', 'out')
    expect(f).toContain('crop=1052:470:0:0')
  })

  it('输入输出标签正确接上', () => {
    const f = buildFitFilter(clip(), aspect, '0:v', 'vout')
    expect(f.startsWith('[0:v]')).toBe(true)
    expect(f.endsWith('[vout]')).toBe(true)
  })
})

describe('buildAudioFilter', () => {
  it('无 BGM 时配音直通', () => {
    const f = buildAudioFilter(false, 0.1)
    expect(f).toContain('[1:a]')
    expect(f).not.toContain('amix')
  })

  it('有 BGM 时混音，且 BGM 按给定音量压低', () => {
    const f = buildAudioFilter(true, 0.1)
    expect(f).toContain('volume=0.1')
    expect(f).toContain('amix=inputs=2')
  })

  it('混音用 normalize=0——否则 amix 会把两轨都压低，配音变小声', () => {
    expect(buildAudioFilter(true, 0.1)).toContain('normalize=0')
  })

  it('混音时长以配音为准——BGM 长了要截断', () => {
    expect(buildAudioFilter(true, 0.1)).toContain('duration=first')
  })
})
