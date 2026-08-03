import { describe, it, expect } from 'vitest'
import { FONT_FAMILY, ASPECT_PRESETS, assertFontAvailable } from '../src/config.js'

describe('config', () => {
  it('字体族名是思源黑体 Medium', () => {
    /*
     * 这个断言存在的意义：族名是【拟合出来的结论】，不是随便选的。
     * 参考图的字重实测介于 Regular 和 Bold 之间，两层 IoU 认到 Medium
     * （Bold 0.790/0.832 vs Medium 0.864/0.913）。改族名 = 所有新片的
     * 标题字幕都换一种粗细，而且和已经烧好的片子对不上。
     */
    expect(FONT_FAMILY).toBe('Source Han Sans CN Medium')
  })

  it('字体在本机可解析', () => {
    expect(() => assertFontAvailable()).not.toThrow()
  })

  it('竖屏预设是 1080x1920', () => {
    expect(ASPECT_PRESETS['9:16']).toEqual({ name: '9:16', width: 1080, height: 1920 })
  })
})
