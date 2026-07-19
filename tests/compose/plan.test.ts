import { describe, it, expect } from 'vitest'
import {
  planBackground,
  DEFAULT_RATIO,
  type Segment,
  type LibraryItem,
} from '../../src/compose/plan.js'

const item = (id: string, durationMs: number): LibraryItem =>
  ({ id, bucket: 'x', filename: `${id}.mp4`, durationMs, sizeBytes: 0 })

const buckets = {
  opening: [item('o1', 30000), item('o2', 30000), item('o3', 30000)],   // 90 秒
  regular: [item('r1', 30000), item('r2', 30000), item('r3', 30000)],   // 90 秒
  parkour: [item('p1', 1800000)],                                       // 30 分钟
}

const rich = {
  opening: Array.from({ length: 20 }, (_, i) => item(`o${i}`, 30000)),  // 10 分钟
  regular: Array.from({ length: 20 }, (_, i) => item(`r${i}`, 30000)),
  parkour: [item('p1', 1800000)],
}

const sumMs = (segs: readonly Segment[]): number =>
  segs.reduce((a, s) => a + s.takeMs, 0)

describe('planBackground', () => {
  /*
   * 【最重要的一条】总长差一毫秒，成片结尾就会黑一帧或截掉半个字。
   * 123457 这个不能被 3 整除的数是故意的——按比例分配必然除不尽，
   * 余数必须被某一段吃掉，不能四舍五入丢掉。
   */
  it('总时长精确等于配音时长——一毫秒都不能差', () => {
    for (const total of [60000, 240000, 660000, 123457, 1]) {
      expect(sumMs(planBackground(total, buckets).segments), `total=${total}`).toBe(total)
    }
  })

  it('totalMs 也原样回报在 plan 上', () => {
    const p = planBackground(123457, buckets)
    expect(p.totalMs).toBe(123457)
  })

  it('默认比例是 27/27/46', () => {
    expect([...DEFAULT_RATIO]).toEqual([0.27, 0.27, 0.46])
  })

  it('11 分钟配音里地铁跑酷占最大一段', () => {
    const p = planBackground(660000, buckets)
    const parkourMs = sumMs(p.segments.filter((s) => s.itemId === 'p1'))
    // 开头桶只有 90 秒，铺不满 178 秒 → 缺口顺延（规则 4）
    expect(parkourMs).toBeGreaterThan(250000)
  })

  it('素材够时，开头段接近目标比例', () => {
    const opening = sumMs(planBackground(660000, rich).segments
      .filter((s) => s.itemId.startsWith('o')))
    expect(opening).toBeGreaterThan(660000 * 0.27 - 30000)
    expect(opening).toBeLessThan(660000 * 0.27 + 30000)
  })

  it('不循环重复：素材够时同一片不出现两次', () => {
    const opens = planBackground(660000, rich).segments
      .filter((s) => s.itemId.startsWith('o')).map((s) => s.itemId)
    expect(new Set(opens).size).toBe(opens.length)
  })

  it('地铁跑酷从长片里截一段，不切成许多碎片', () => {
    const takes = planBackground(660000, buckets).segments
      .filter((s) => s.itemId === 'p1').map((s) => s.takeMs)
    expect(takes).toHaveLength(1)
    expect(Math.min(...takes)).toBeGreaterThan(250000)
  })

  it('段落顺序是 开头 → 常规 → 地铁跑酷', () => {
    const ids = planBackground(660000, rich).segments.map((s) => s.itemId[0])
    const firstR = ids.indexOf('r')
    const firstP = ids.indexOf('p')
    expect(ids.lastIndexOf('o')).toBeLessThan(firstR)
    expect(ids.lastIndexOf('r')).toBeLessThan(firstP)
  })

  it('每段的截取区间不超出源文件时长', () => {
    const p = planBackground(660000, buckets)
    const dur = new Map([...buckets.opening, ...buckets.regular, ...buckets.parkour]
      .map((i) => [i.id, i.durationMs]))
    for (const s of p.segments) {
      expect(s.startMs).toBeGreaterThanOrEqual(0)
      expect(s.startMs + s.takeMs).toBeLessThanOrEqual(dur.get(s.itemId) ?? -1)
    }
  })

  it('不产生零长片段', () => {
    for (const total of [1, 3, 123457, 660000]) {
      const takes = planBackground(total, buckets).segments.map((s) => s.takeMs)
      expect(Math.min(...takes), `total=${total}`).toBeGreaterThan(0)
    }
  })

  it('空桶不崩溃，缺口顺延给有素材的桶', () => {
    const p = planBackground(60000,
      { opening: [], regular: [], parkour: [item('p1', 600000)] })
    expect(sumMs(p.segments)).toBe(60000)
  })

  it('全空桶抛出可读的错误', () => {
    expect(() => planBackground(60000, { opening: [], regular: [], parkour: [] }))
      .toThrow(/素材/)
  })
})

describe('planBackground 的边界情况', () => {
  it('1 毫秒配音也精确排布', () => {
    const p = planBackground(1, buckets)
    expect(sumMs(p.segments)).toBe(1)
    expect(p.segments).toHaveLength(1)
  })

  it('配音时长非正数被拒绝', () => {
    for (const bad of [0, -1, -123457]) {
      expect(() => planBackground(bad, buckets), `total=${bad}`).toThrow(/时长/)
    }
  })

  it('配音时长必须是整数毫秒', () => {
    expect(() => planBackground(1000.5, buckets)).toThrow(/时长/)
  })

  it('时长为 0 的素材被跳过，不会导致死循环', () => {
    const p = planBackground(10000, {
      opening: [item('o0', 0), item('o1', 0)],
      regular: [item('r0', 0)],
      parkour: [item('p0', 0), item('p1', 60000)],
    })
    expect(sumMs(p.segments)).toBe(10000)
    expect(p.segments.map((s) => s.itemId)).toEqual(['p1'])
  })

  it('单个桶的素材远超需要时，只取需要的那部分', () => {
    const p = planBackground(1000, {
      opening: [item('o1', 3600000)],
      regular: [item('r1', 3600000)],
      parkour: [item('p1', 3600000)],
    })
    expect(sumMs(p.segments)).toBe(1000)
    // 1000ms × 0.27 = 270 / 270 / 460
    expect(p.segments).toEqual([
      { itemId: 'o1', startMs: 0, takeMs: 270 },
      { itemId: 'r1', startMs: 0, takeMs: 270 },
      { itemId: 'p1', startMs: 0, takeMs: 460 },
    ])
  })

  /*
   * 规则 5：素材总量不够铺满整条轨时，只能循环——这是最后手段，
   * 必须能被观察到，否则实现里悄悄丢掉几秒也没人发现。
   */
  it('素材总量不够时循环复用，且总长仍然精确', () => {
    const tiny = {
      opening: [item('o1', 1000)],
      regular: [item('r1', 1000)],
      parkour: [item('p1', 1000)],
    }
    const p = planBackground(10000, tiny)
    expect(sumMs(p.segments)).toBe(10000)
    const ids = p.segments.map((s) => s.itemId)
    expect(ids.length).toBeGreaterThan(new Set(ids).size)  // 确有重复 = 确有循环
  })

  it('自定义比例同样保证总长精确', () => {
    for (const ratio of [
      [0.5, 0.3, 0.2],
      [0, 0, 1],
      [1, 0, 0],
      [0.333, 0.333, 0.334],
    ] as const) {
      const p = planBackground(123457, rich, ratio)
      expect(sumMs(p.segments), `ratio=${ratio.join('/')}`).toBe(123457)
    }
  })

  it('非法比例被拒绝', () => {
    expect(() => planBackground(60000, buckets, [-0.1, 0.5, 0.6])).toThrow(/比例/)
    expect(() => planBackground(60000, buckets, [0.2, 0.2, 0.2])).toThrow(/比例/)
  })

  it('比例为 1/0/0 且开头桶铺不满时，缺口一路顺延到地铁跑酷', () => {
    const p = planBackground(660000, buckets, [1, 0, 0])
    expect(sumMs(p.segments)).toBe(660000)
    const byBucket = {
      o: sumMs(p.segments.filter((s) => s.itemId.startsWith('o'))),
      r: sumMs(p.segments.filter((s) => s.itemId.startsWith('r'))),
      p: sumMs(p.segments.filter((s) => s.itemId.startsWith('p'))),
    }
    expect(byBucket).toEqual({ o: 90000, r: 90000, p: 480000 })
  })

  it('输入的桶数组不被就地修改', () => {
    const before = buckets.opening.map((i) => i.id)
    planBackground(660000, buckets)
    expect(buckets.opening.map((i) => i.id)).toEqual(before)
  })
})
