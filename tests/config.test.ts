import { describe, it, expect } from 'vitest'
import { FONT_FAMILY, ASPECT_PRESETS, assertFontAvailable } from '../src/config.js'

describe('config', () => {
  it('字体族名是 Noto Sans CJK SC，不是 Noto Sans SC', () => {
    // 这个断言存在的意义：防止有人"顺手改回"看起来更合理的那个名字
    expect(FONT_FAMILY).toBe('Noto Sans CJK SC')
  })

  it('字体在本机可解析', () => {
    expect(() => assertFontAvailable()).not.toThrow()
  })

  it('竖屏预设是 1080x1920', () => {
    expect(ASPECT_PRESETS['9:16']).toEqual({ name: '9:16', width: 1080, height: 1920 })
  })
})
