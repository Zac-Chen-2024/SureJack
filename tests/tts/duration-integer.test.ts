import { describe, it, expect } from 'vitest'
import { hnsToMs } from '../../src/tts/azure.js'

/*
 * 配音时长必须是【整数毫秒】。
 *
 * Azure 的 audioDuration 单位是 100 纳秒（HNS），除以 10000 换成毫秒时
 * 会出小数——实测一条 1 分钟的配音返回 65087.5ms。而 planBackground()
 * 要求正整数才能保证三段之和精确等于总长，于是整条背景排布 500。
 *
 * 这个 bug 在 406 个单元测试里全部漏掉了，因为测试数据用的都是整数时长
 * （1800 / 200 / 3000 这种）。只有真调一次 Azure 才会撞上。
 *
 * 【为什么长文案没事、短文案才炸】：长文案走 synthesizeLong，总时长来自
 * probeDurationMs（它 Math.round 过）；短文案单段直通 synthesize，
 * 拿的是 Azure 的原始值。所以 13 分钟的片子导得出来，1 分钟的反而炸。
 */

describe('hnsToMs', () => {
  it('把 100 纳秒单位换成整数毫秒', () => {
    expect(hnsToMs(650_875_000)).toBe(65_088)   // 实测那条：65087.5 → 65088
    expect(hnsToMs(10_000)).toBe(1)
    expect(hnsToMs(0)).toBe(0)
  })

  it('结果一定是整数，绝不是小数', () => {
    // 扫一批会产生 .5 / .1 / .9 尾数的值
    for (let hns = 650_870_000; hns <= 650_880_000; hns += 1000) {
      const ms = hnsToMs(hns)
      expect(Number.isInteger(ms)).toBe(true)
    }
  })

  it('四舍五入而不是截断——截断会让成片比配音短', () => {
    expect(hnsToMs(19_999)).toBe(2)    // 1.9999ms，截断会得 1
  })
})
