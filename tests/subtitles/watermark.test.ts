import { describe, it, expect } from 'vitest'
import {
  watermarkSegments, watermarkPoint, WATERMARK_ANCHORS, WATERMARK_CYCLE_MS,
  WATERMARK_FONT_SIZE, WATERMARK_MARGIN_H, WATERMARK_MARGIN_V,
} from '../../src/subtitles/watermark.js'
import { buildAss } from '../../src/subtitles/ass.js'
import type { BuildAssOptions } from '../../src/subtitles/ass.js'
import type { AspectPreset } from '../../src/types.js'

const ASPECT: AspectPreset = { name: '9:16', width: 1080, height: 1920 }

const BASE: BuildAssOptions = {
  lines: [{ startMs: 0, endMs: 2000, words: [{ text: '他站在门口', offsetMs: 0, durationMs: 2000, isPunctuation: false }] }],
  overlays: [{ content: '标题', style: 'Title', startMs: null, endMs: null }],
  aspect: ASPECT,
  durationMs: 240_000,
  mode: 'line',
}

const names = (durationMs: number): string[] =>
  watermarkSegments(durationMs).map((s) => s.from.name)

describe('水印的位置轮转', () => {
  it('顺序就是用户给的六个角', () => {
    expect(WATERMARK_ANCHORS.map((a) => a.name))
      .toEqual(['左上', '右中', '左下', '右上', '左中', '右下'])
  })

  it('时间节点是 0 / 1分半 / 3分 / 6分 / 9分 / 12分', () => {
    expect(watermarkSegments(13 * 60_000).map((s) => s.startMs))
      .toEqual([0, 90_000, 180_000, 360_000, 540_000, 720_000])
  })

  /**
   * 用户原话："如果不够长也按照这个时间分布来烧录"。
   * 四分钟的片子就该只走到第三个角，而不是把六个角压缩进四分钟。
   */
  it('片子不够长就走到哪算哪，不压缩时间表', () => {
    expect(names(4 * 60_000)).toEqual(['左上', '右中', '左下'])
    const last = watermarkSegments(4 * 60_000).at(-1)
    expect(last?.endMs).toBe(4 * 60_000)   // 最后一段裁到片尾，不越界
  })

  it('一分钟的片子全程只有左上一个位置', () => {
    expect(names(60_000)).toEqual(['左上'])
  })

  /*
   * 一轮走完不是"滑回左上"，是【停在右下、到点瞬移】。
   * 滑回去要横穿整个画面，把观众视线拽着走一遍；而回到原点本身不是运动。
   */
  it('最后一段停在右下不动（终点=起点），下一轮直接从左上开始', () => {
    const segs = watermarkSegments(WATERMARK_CYCLE_MS + 100_000)
    const last = segs[5]!
    expect(last.from.name).toBe('右下')
    expect(last.to.name).toBe('右下')       // 原地不动
    expect(segs[6]!.from.name).toBe('左上')  // 瞬移
  })

  it('比一轮还长就循环回左上', () => {
    const segs = watermarkSegments(WATERMARK_CYCLE_MS + 100_000)
    expect(segs.map((s) => s.from.name).slice(0, 7))
      .toEqual(['左上', '右中', '左下', '右上', '左中', '右下', '左上'])
    expect(segs[6]?.startMs).toBe(WATERMARK_CYCLE_MS)
  })

  it('时长为 0 或非法时不产生任何一段', () => {
    expect(watermarkSegments(0)).toEqual([])
    expect(watermarkSegments(-1)).toEqual([])
    expect(watermarkSegments(Number.NaN)).toEqual([])
  })

  it('每一段首尾相接、不重叠', () => {
    const segs = watermarkSegments(20 * 60_000)
    for (const [i, s] of segs.entries()) {
      expect(s.endMs).toBeGreaterThan(s.startMs)
      if (i > 0) expect(s.startMs).toBe(segs[i - 1]?.endMs)
    }
  })
})

describe('水印进 ASS', () => {
  it('不传水印时，ASS 里一个字都不多', () => {
    const ass = buildAss(BASE)
    expect(ass).not.toContain('Watermark')
  })

  it('空字符串和空白也当作不打水印', () => {
    expect(buildAss({ ...BASE, watermark: '' })).not.toContain('Watermark')
    expect(buildAss({ ...BASE, watermark: '   ' })).not.toContain('Watermark')
  })

  it('传了水印就有一个样式 + 每段一条会动的 Dialogue', () => {
    const ass = buildAss({ ...BASE, watermark: '周周' })
    const styles = ass.split('\n').filter((l) => l.startsWith('Style: Watermark'))
    const events = ass.split('\n').filter((l) => l.includes(',Watermark,,'))
    expect(styles).toHaveLength(1)          // 六个角共用一个样式，靠 \move 定位
    expect(events).toHaveLength(3)          // 4 分钟 → 三段
    for (const e of events) expect(e).toMatch(/\{\\an5\\move\(\d+,\d+,\d+,\d+,0,\d+\)\}周周$/)
  })

  it('每一段的终点就是下一段的起点，接得上不跳', () => {
    const events = buildAss({ ...BASE, watermark: '周周' }).split('\n')
      .filter((l) => l.includes(',Watermark,,'))
      .map((l) => /move\((\d+),(\d+),(\d+),(\d+),/.exec(l)!.slice(1).map(Number))
    for (const [i, e] of events.entries()) {
      if (i === 0) continue
      expect([e[0], e[1]]).toEqual([events[i - 1]![2], events[i - 1]![3]])
    }
  })

  /*
   * 片尾把最后一段截断时，\move 的时间参数必须还是【整段本该走多久】。
   * 写成这条 Dialogue 的实际时长的话，水印会在最后几十秒里加速冲刺。
   */
  it('最后一段被片尾截断，速度不变（\\move 时长仍是整段）', () => {
    const ass = buildAss({ ...BASE, durationMs: 200_000, watermark: '周周' })
    const last = ass.split('\n').filter((l) => l.includes(',Watermark,,')).at(-1)!
    expect(last).toContain(',0,180000)}')      // 第三段（3分→6分）本该走 180 秒
    expect(last).toContain('0:03:20.00,')      // 但只画到 3:20（片尾）
  })

  it('六个角的坐标都贴着边，且落在画面里', () => {
    const W = 1080, H = 1920
    for (const a of WATERMARK_ANCHORS) {
      const p = watermarkPoint(a, '周周', WATERMARK_FONT_SIZE, W, H)
      expect(p.x).toBeGreaterThan(WATERMARK_MARGIN_H)
      expect(p.x).toBeLessThan(W - WATERMARK_MARGIN_H)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(H)
      if (a.vy === 'middle') expect(p.y).toBeCloseTo(H / 2, -1)
    }
    /*
     * 左右对称的是【墨迹】，不是锚点。墨迹中心比锚点偏左 1px（实测），
     * 两边都要往右补这 1px，于是两个锚点到各自边的距离差 2px——正常。
     */
    const l = watermarkPoint(WATERMARK_ANCHORS[0]!, '周周', WATERMARK_FONT_SIZE, W, H)
    const r = watermarkPoint(WATERMARK_ANCHORS[1]!, '周周', WATERMARK_FONT_SIZE, W, H)
    expect(Math.abs(l.x - (W - r.x))).toBeLessThanOrEqual(2)
  })

  it('文字越长，贴边的锚点越往画面中间挪（贴的是墨迹不是锚点）', () => {
    const W = 1080, H = 1920
    const short = watermarkPoint(WATERMARK_ANCHORS[0]!, '甲', WATERMARK_FONT_SIZE, W, H)
    const long = watermarkPoint(WATERMARK_ANCHORS[0]!, '周周撸铁', WATERMARK_FONT_SIZE, W, H)
    expect(long.x).toBeGreaterThan(short.x)
  })

  /**
   * ⚠️ 这条是【历史成片不重烧】的守门员。算指纹走的就是 legacyStyle 那条路，
   * 一旦水印漏进去，十几条老片子的母带指纹立刻失效、开机补合全部重烧。
   */
  it('算指纹的那份（legacyStyle）永远不画水印，哪怕传了', () => {
    const ass = buildAss({ ...BASE, legacyStyle: true, watermark: '周周' })
    expect(ass).not.toContain('Watermark')
    expect(ass).toBe(buildAss({ ...BASE, legacyStyle: true }))
  })

  it('水印文字照样要转义，不能被当成 ASS 语法', () => {
    const ass = buildAss({ ...BASE, watermark: '{周}' })
    expect(ass).toContain('\\{周\\}')
  })

  it('样式行必须正好 23 个字段', () => {
    // libass 对字段数不对的样式行是【静默丢弃】：不报错，只是整条水印不出现
    const line = buildAss({ ...BASE, watermark: '周周' })
      .split('\n').find((l) => l.startsWith('Style: Watermark'))
    expect(line?.slice('Style: '.length).split(',')).toHaveLength(23)
  })

  it('字和描边用同一个半透明度（用户要求框和字一样透）', () => {
    const line = buildAss({ ...BASE, watermark: '周周' })
      .split('\n').find((l) => l.startsWith('Style: Watermark'))!
    const f = line.slice('Style: '.length).split(',')
    expect(f[3]).toBe('&H8AFFFFFF')   // PrimaryColour：白，46% 不透明
    expect(f[5]).toBe('&H8A000000')   // OutlineColour：黑，同样 46%
  })
})
