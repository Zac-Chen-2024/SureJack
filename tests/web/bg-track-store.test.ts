import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  bgTrackNotice, bgTrackSrc, shouldPollBgTrack,
  usePipeline, type BgTrack,
} from '../../web/src/store/pipeline'

function bg (over: Partial<BgTrack> = {}): BgTrack {
  // 【不用 as BgTrack 硬转】：字段名写错要当场编译失败，不是等到界面空白
  return { state: 'none', assetId: null, ...over }
}

describe('bgTrackNotice —— 每种状态说一句不一样的话', () => {
  it('拼好了 → 什么都不说，画面自己在那儿', () => {
    expect(bgTrackNotice(bg({ state: 'ready', assetId: 'a1' }))).toBe(null)
  })

  it('还在拼 → 说「背景生成中」，别让用户以为坏了', () => {
    const msg = bgTrackNotice(bg({ state: 'building' }))
    expect(msg).toContain('背景生成中')
  })

  it('拼失败 → 必须说清【导出时会重新生成】', () => {
    /*
     * 这条是这个任务里最容易做错的地方。预拼是个优化，它失败了导出
     * 照样能出片（后端有那条回退路径）。文案要是只说「背景生成失败」，
     * 用户会以为片子导不出来了，然后不敢点导出——一个后台优化把主流程
     * 吓停了，比不做这个优化还糟。
     */
    const msg = bgTrackNotice(bg({ state: 'error' })) ?? ''
    expect(msg).toContain('导出')
    expect(msg).toContain('重新生成')
    // 【不许出现"失败"二字】：预览拼不出来不是用户的失败，也不是导出的失败
    expect(msg).not.toContain('失败')
  })

  it('还没到时候（配音没好、库没扫）→ 沿用原来那句"成片里会有"', () => {
    expect(bgTrackNotice(bg({ state: 'none' }))).toContain('成片')
  })

  it('状态还没拉回来（null）→ 也按"还没到时候"说', () => {
    expect(bgTrackNotice(null)).toContain('成片')
  })

  it('四种状态的文案两两不同——合并了就等于少说了一件事', () => {
    const msgs = (['none', 'building', 'error'] as const).map((s) => bgTrackNotice(bg({ state: s })))
    expect(new Set(msgs).size).toBe(msgs.length)
  })
})

describe('bgTrackSrc —— 预览的 <video> 指向哪儿', () => {
  it('拼好了就指向那条轨', () => {
    expect(bgTrackSrc(bg({ state: 'ready', assetId: 'abc' }))).toBe('/api/assets/abc')
  })

  it('没拼好一律不给 src', () => {
    for (const state of ['none', 'building', 'error'] as const) {
      expect(bgTrackSrc(bg({ state, assetId: 'abc' })), state).toBe(null)
    }
  })

  it('说 ready 但没给 id → 不给 src，不去请求一个 /api/assets/null', () => {
    expect(bgTrackSrc(bg({ state: 'ready', assetId: null }))).toBe(null)
  })

  it('状态没拉回来 → 不给 src', () => {
    expect(bgTrackSrc(null)).toBe(null)
  })
})

describe('shouldPollBgTrack —— 只在还有戏的时候轮询', () => {
  it('正在拼 → 继续问', () => {
    expect(shouldPollBgTrack(bg({ state: 'building' }))).toBe(true)
  })

  it('拼好了 / 失败了 → 停', () => {
    // 已成终态还接着问，就是让两个用户的机器白白多跑一串请求
    expect(shouldPollBgTrack(bg({ state: 'ready', assetId: 'a' }))).toBe(false)
    expect(shouldPollBgTrack(bg({ state: 'error' }))).toBe(false)
  })

  it('none 也停——那是"配音还没好"，等配音好了自然会重新拉', () => {
    expect(shouldPollBgTrack(bg({ state: 'none' }))).toBe(false)
  })

  it('还没拉过（null）→ 要问一次', () => {
    expect(shouldPollBgTrack(null)).toBe(true)
  })
})

describe('loadBgTrack —— 拉状态这件事本身不许把预览搞崩', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { usePipeline.getState().reset() })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('拉到什么就存什么', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ state: 'ready', assetId: 'a9' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

    await usePipeline.getState().loadBgTrack('p1')
    expect(usePipeline.getState().bgTrack).toEqual({ state: 'ready', assetId: 'a9' })
  })

  it('接口挂了 → 落成 none，【不写 error】', async () => {
    /*
     * 【别把网络错误说成"背景拼失败"】。500 或者断网时我们根本不知道
     * 背景轨怎么样了，说 error 是在编造一个自己没看见的失败。
     * 退回 none，界面就是原来那句"成片里会有"——保守、且永远为真。
     */
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: '服务器内部错误' }), { status: 500 },
    )) as typeof fetch

    await usePipeline.getState().loadBgTrack('p1')
    expect(usePipeline.getState().bgTrack).toEqual({ state: 'none', assetId: null })
    // 【不许污染那条红色报错】：那是给导出/配音失败用的
    expect(usePipeline.getState().error).toBe(null)
  })

  it('切项目时状态被清掉，不会把上一个项目的背景轨播给这个项目', () => {
    usePipeline.setState({ bgTrack: { state: 'ready', assetId: '上一个项目的' } })
    usePipeline.getState().reset()
    expect(usePipeline.getState().bgTrack).toBe(null)
  })
})
