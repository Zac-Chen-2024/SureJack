import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { filmButton, shouldPollFilm, usePipeline, type Film } from '../../web/src/store/pipeline'

function film (patch: Partial<Film>): Film {
  return { state: 'none', jobId: null, progress: 0, error: null, reason: null, ...patch }
}

describe('下载按钮该长什么样', () => {
  it('还没配音 → 不能点，并说清先去生成配音', () => {
    const b = filmButton(null, false)
    expect(b.enabled).toBe(false)
    expect(b.action).toBe('none')
    expect(b.hint).toContain('配音')
  })

  it('成片就绪 → 「下载视频」，可点，点了就是下载', () => {
    const b = filmButton(film({ state: 'ready' }), true)
    expect(b.label).toBe('下载视频')
    expect(b.enabled).toBe(true)
    expect(b.action).toBe('download')
  })

  it('合成中 → 不能点，且【不能长得像出错了】', () => {
    const b = filmButton(film({ state: 'building', progress: 42 }), true)
    expect(b.enabled).toBe(false)
    expect(b.action).toBe('none')
    expect(b.hint).toContain('后台')
  })

  it('合成失败 → 可点重试，并把原因原样说出来', () => {
    const b = filmButton(film({ state: 'error', error: 'ffmpeg 退出码 1' }), true)
    expect(b.enabled).toBe(true)
    expect(b.action).toBe('retry')
    expect(b.hint).toBe('ffmpeg 退出码 1')
  })

  it('失败但后端没给原因，也要有句话，不能是空白', () => {
    expect(filmButton(film({ state: 'error' }), true).hint).toBeTruthy()
  })

  it('配音好了但还差别的（比如素材库没扫）→ 把后端那句 reason 说出来', () => {
    const b = filmButton(film({ state: 'none', reason: '素材库里没有可用的视频素材，请先扫描素材库' }), true)
    expect(b.enabled).toBe(false)
    expect(b.hint).toBe('素材库里没有可用的视频素材，请先扫描素材库')
  })
})

describe('还要不要接着问成片状态', () => {
  it('本次会话还没问过 → 要问', () => {
    expect(shouldPollFilm(null)).toBe(true)
  })

  it('合成中 → 要问', () => {
    expect(shouldPollFilm(film({ state: 'building' }))).toBe(true)
  })

  it('已就绪 → 停。终态还接着问就是让两个用户的机器白跑', () => {
    expect(shouldPollFilm(film({ state: 'ready' }))).toBe(false)
  })

  it('失败 → 停。失败要靠用户点重试，不该自己转圈重排', () => {
    expect(shouldPollFilm(film({ state: 'error' }))).toBe(false)
  })

  it('none → 停。缺的东西（配音/素材）变了会由 project 的变化重新触发', () => {
    expect(shouldPollFilm(film({ state: 'none' }))).toBe(false)
  })
})

describe('成片状态的拉取', () => {
  beforeEach(() => { usePipeline.getState().reset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('拉到什么就存什么', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(film({ state: 'building', jobId: 'j1', progress: 30 })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    await usePipeline.getState().loadFilm('p1')
    expect(usePipeline.getState().film?.state).toBe('building')
    expect(usePipeline.getState().film?.progress).toBe(30)
  })

  it('【拉失败绝不置成 error】——我们根本不知道成片怎么样，不能编造一个失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await usePipeline.getState().loadFilm('p1')
    expect(usePipeline.getState().error).toBe(null)
  })

  /*
   * 线上真事：重启了一次服务，正好打空一轮轮询，按钮就永久停在
   * "还不能合成成片"——后台其实早合完了。原因是失败时把状态填成了 'none'，
   * 而 none 是终态、不再轮询，于是没有任何东西能把它解开。
   */
  it('【拉失败要拉回未知态，不能填成 none】否则轮询停死，一次闪断永久卡住', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await usePipeline.getState().loadFilm('p1')

    const after = usePipeline.getState().film
    expect(after).toBe(null)
    // 真正要守的性质：失败之后必须还会接着问，否则自己恢复不了
    expect(shouldPollFilm(after)).toBe(true)
    // 而且绝不能显示那句后端从没说过的兜底话
    expect(filmButton(after, true).hint).not.toBe('还不能合成成片。')
  })

  it('闪断之后下一轮就该自己恢复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await usePipeline.getState().loadFilm('p1')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(film({ state: 'ready', jobId: 'j1', progress: 100 })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    await usePipeline.getState().loadFilm('p1')
    expect(filmButton(usePipeline.getState().film, true).label).toBe('下载视频')
    expect(filmButton(usePipeline.getState().film, true).enabled).toBe(true)
  })

  it('切项目要清掉，否则上一个项目的成片会看起来是这个项目的', () => {
    usePipeline.setState({ film: film({ state: 'ready' }) })
    usePipeline.getState().reset()
    expect(usePipeline.getState().film).toBe(null)
  })
})
