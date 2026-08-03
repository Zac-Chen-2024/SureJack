import { describe, it, expect } from 'vitest'
import {
  maxSubtitleMarginV, subtitleHeightLabel, DEFAULT_SUBTITLE_MARGIN_V,
} from '../../web/src/store/projects'
import {
  maxSubtitleMarginV as serverMax,
  clampSubtitleMarginV,
} from '../../src/subtitles/project-ass.js'
import { DEFAULT_SUBTITLE_MARGIN_V as SERVER_DEFAULT } from '../../src/subtitles/ass.js'

describe('maxSubtitleMarginV（前端滑块上界）', () => {
  /*
   * 上界 = 画面高 − 一个最大字号（120）。
   *
   * ⚠️ 原来是"画面高的一半"。那道线挡住了参考图里的位置（离底 1000，
   * 超过 9:16 的半屏 960），也挡住了"想把字幕放上半屏"这种正当排版——
   * 它不是安全边界，是个没说清理由的产品判断。现在这条才是物理边界：
   * 字号拉到最大时，字顶正好不出画。
   */
  it('上界 = 画面高 − 最大字号', () => {
    expect(maxSubtitleMarginV('9:16')).toBe(1800)
    expect(maxSubtitleMarginV('16:9')).toBe(960)
    expect(maxSubtitleMarginV('1:1')).toBe(960)
    expect(maxSubtitleMarginV('4:5')).toBe(1230)
  })

  it('认不出的画幅回落竖屏，不返回 NaN 把滑块弄坏', () => {
    expect(maxSubtitleMarginV('乱写')).toBe(1800)
  })

  /**
   * web/ 是独立的 TS 工程（tsconfig.app.json 的 include 只有 src），
   * 跨目录 import 不了后端代码，所以这个上界在两边各写了一份。
   * 这条测试就是那份重复的看门人：**两边算出来的必须一模一样**，
   * 否则滑块能拖到一个后端会悄悄钳回去的位置，用户松手后跳一下。
   */
  it('和后端的钳位上界逐个画幅对齐', () => {
    for (const aspect of ['9:16', '16:9', '1:1', '4:5', '乱写']) {
      expect(maxSubtitleMarginV(aspect)).toBe(serverMax(aspect))
      expect(clampSubtitleMarginV(99_999, aspect)).toBe(maxSubtitleMarginV(aspect))
    }
  })

  it('前端的默认值和后端列默认值是同一个数', () => {
    expect(DEFAULT_SUBTITLE_MARGIN_V).toBe(SERVER_DEFAULT)
  })
})

describe('subtitleHeightLabel（相对说法，不露像素数）', () => {
  const max = 960

  it('全程只给相对说法，任何取值都不出现数字', () => {
    for (let v = 0; v <= max; v += 40) {
      expect(subtitleHeightLabel(v, max)).not.toMatch(/\d/)
    }
  })

  it('从低到高依次是 贴底 / 偏下 / 居中偏下 / 偏上', () => {
    expect(subtitleHeightLabel(0, max)).toBe('贴底')
    expect(subtitleHeightLabel(300, max)).toBe('偏下')     // 默认值落在这一档
    expect(subtitleHeightLabel(600, max)).toBe('居中偏下')
    expect(subtitleHeightLabel(800, max)).toBe('偏上')
    expect(subtitleHeightLabel(max, max)).toBe('偏上')
  })

  it('说法随取值单调不倒退——拖高了不该反而显示更低的档', () => {
    const order = ['贴底', '偏下', '居中偏下', '偏上']
    let last = 0
    for (let v = 0; v <= max; v += 10) {
      const i = order.indexOf(subtitleHeightLabel(v, max))
      expect(i).toBeGreaterThanOrEqual(last)
      last = i
    }
    expect(last).toBe(3)
  })

  it('max 为 0 时不崩、不产出 NaN（除零防线）', () => {
    expect(subtitleHeightLabel(0, 0)).toBe('贴底')
  })
})

describe('前后端常量必须对齐', () => {
  /*
   * 前端不能 import 后端（打包进不去），所以同一个常量两边各存一份。
   * 这条测试是唯一让它们不悄悄跑偏的东西——改一边忘了另一边，
   * 表现是"新建项目的水印默认值和实际烧出来的不一样"，很难往这儿想。
   */
  it('水印默认值两边一样', async () => {
    const web = await import('../../web/src/store/projects')
    const backend = await import('../../src/subtitles/watermark.js')
    expect(web.DEFAULT_WATERMARK).toBe(backend.DEFAULT_WATERMARK)
  })
})
