import { describe, it, expect } from 'vitest'
import {
  parseBgmName, groupPhases, segmentShares, describePlan, formatClock, bucketLabel,
  type BgSegment, type BgPhase,
} from '../../web/src/store/library'

function seg (bucket: string, takeMs: number, startMs = 0): BgSegment {
  return { itemId: `${bucket}-${startMs}-${takeMs}`, filename: `${bucket}.mp4`, bucket, startMs, takeMs }
}

function phase (bucket: string, takeMs: number, clipCount = 1): BgPhase {
  return { bucket, takeMs, clipCount }
}

describe('parseBgmName', () => {
  it('第一个空格前是曲名，其余是标签', () => {
    expect(parseBgmName('一笑倾城 现言 甜文.wav')).toEqual({ title: '一笑倾城', tags: '现言 甜文' })
  })

  it('只有曲名时标签为空字符串，不是 undefined', () => {
    expect(parseBgmName('若梦.wav')).toEqual({ title: '若梦', tags: '' })
  })

  it('扩展名按最后一个点切——曲名里带点不会被截断', () => {
    expect(parseBgmName('第一.二章 古风.mp3')).toEqual({ title: '第一.二章', tags: '古风' })
  })

  it('没有扩展名也能拆', () => {
    expect(parseBgmName('江南 民乐')).toEqual({ title: '江南', tags: '民乐' })
  })

  it('多个连续空格算一个分隔，标签不带前导空白', () => {
    expect(parseBgmName('一笑倾城   现言 甜文.wav')).toEqual({ title: '一笑倾城', tags: '现言 甜文' })
  })

  it('以点开头的文件名不当成扩展名，整个是曲名', () => {
    expect(parseBgmName('.gitkeep')).toEqual({ title: '.gitkeep', tags: '' })
  })
})

/**
 * 后端回的是几十个几秒长的源片段，三段式说的是三个【阶段】。
 * 这一组测试守的就是"38 条头发丝要收成 3 段"这件事。
 */
describe('groupPhases', () => {
  it('相邻同桶的片段并成一段，时长相加、片段数计数', () => {
    expect(groupPhases([
      seg('1-开头', 5000), seg('1-开头', 6000),
      seg('2-常规', 7000),
      seg('3-地铁跑酷', 8000), seg('3-地铁跑酷', 9000), seg('3-地铁跑酷', 1000),
    ])).toEqual([
      phase('1-开头', 11_000, 2),
      phase('2-常规', 7000, 1),
      phase('3-地铁跑酷', 18_000, 3),
    ])
  })

  it('真实排布的 38 段收成 3 段，比例仍是 27/27/46', () => {
    const segments = [
      ...Array.from({ length: 13 }, () => seg('1-开头', 213_300 / 13)),
      ...Array.from({ length: 17 }, () => seg('2-常规', 213_300 / 17)),
      ...Array.from({ length: 8 }, () => seg('3-地铁跑酷', 363_400 / 8)),
    ]
    expect(segments).toHaveLength(38)
    const phases = groupPhases(segments)
    expect(phases.map((p) => p.bucket)).toEqual(['1-开头', '2-常规', '3-地铁跑酷'])
    expect(phases.map((p) => p.clipCount)).toEqual([13, 17, 8])
    expect(segmentShares(phases)).toEqual([27, 27, 46])
  })

  it('按【相邻】而不是全局分组——A→B→A 是三段，不能谎称 A 是连续的一段', () => {
    expect(groupPhases([seg('a', 1000), seg('b', 1000), seg('a', 1000)]))
      .toEqual([phase('a', 1000), phase('b', 1000), phase('a', 1000)])
  })

  it('空排布回空数组', () => {
    expect(groupPhases([])).toEqual([])
  })
})

describe('segmentShares', () => {
  it('按 takeMs 等比', () => {
    expect(segmentShares([phase('1-开头', 1000), phase('2-常规', 1000), phase('3-地铁跑酷', 2000)]))
      .toEqual([25, 25, 50])
  })

  it('和恰好是 100——独立取整会累出误差，把分段条挤断行', () => {
    // 三等分：33.33 各自取整只有 99，缺的那 1 要发出去
    const shares = segmentShares([phase('a', 1), phase('b', 1), phase('c', 1)])
    expect(shares.reduce((x, y) => x + y, 0)).toBe(100)
    expect(shares).toEqual([34, 33, 33])
  })

  it('默认比例 27/27/46 得到的就是 27/27/46', () => {
    expect(segmentShares([phase('1-开头', 270), phase('2-常规', 270), phase('3-地铁跑酷', 460)]))
      .toEqual([27, 27, 46])
  })

  it('空排布回空数组，不除以 0', () => {
    expect(segmentShares([])).toEqual([])
  })

  it('总时长为 0 时全给 0，不产生 NaN 宽度', () => {
    expect(segmentShares([phase('a', 0), phase('b', 0)])).toEqual([0, 0])
  })
})

describe('formatClock', () => {
  it('格式是 m:ss，秒补零', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(18_000)).toBe('0:18')
    expect(formatClock(211_000)).toBe('3:31')
    expect(formatClock(600_000)).toBe('10:00')
  })

  it('负数和非法值钳到 0，不把说明行撑坏', () => {
    expect(formatClock(-1)).toBe('0:00')
    expect(formatClock(NaN)).toBe('0:00')
    expect(formatClock(Infinity)).toBe('0:00')
  })
})

describe('bucketLabel', () => {
  it('去掉排序前缀——前缀是给目录排序看的，不是给人看的', () => {
    expect(bucketLabel('1-开头')).toBe('开头')
    expect(bucketLabel('3-地铁跑酷')).toBe('地铁跑酷')
  })

  it('没有前缀就原样返回', () => {
    expect(bucketLabel('背景音乐')).toBe('背景音乐')
  })
})

describe('describePlan', () => {
  it('一行说清每段多长、来自哪个桶', () => {
    expect(describePlan([
      phase('1-开头', 18_000), phase('2-常规', 18_000), phase('3-地铁跑酷', 30_000),
    ])).toBe('0:18 开头 · 0:18 常规 · 0:30 地铁跑酷')
  })

  it('空排布得到空字符串，不是一串孤零零的分隔点', () => {
    expect(describePlan([])).toBe('')
  })
})
