import { describe, it, expect } from 'vitest'
import { cutPointsOf, planCuts, SUBTITLE_CUT_MAX } from '../../src/subtitles/cut-ai.js'

/*
 * ⚠️ 这一整个文件守的是同一件事：【模型不许改一个字】。
 *
 * 配音是照着原文案念的，字幕的时间轴是从 Azure 的词级时间戳推出来的。
 * 模型只要动了一个字，字幕就和耳朵里听到的对不上、时间轴也接不回去。
 * 所以宁可整句回退到机械切法，也不能放一个"看起来更顺"的改写版进去。
 */

const SRC = '他把那只旧木箱推到墙角箱子里只剩半张泛黄的照片'

describe('逐字校验（改了字就整条作废）', () => {
  it('只插分隔符 → 通过，给出断点', () => {
    expect(cutPointsOf(SRC, '他把那只旧木箱推到墙角|箱子里只剩半张泛黄的照片')).toEqual([11])
  })

  it('切三段也行', () => {
    const pts = cutPointsOf('一二三四五六七八九十', '一二三|四五六七|八九十')
    expect(pts).toEqual([3, 7])
  })

  it.each([
    ['改了一个字', '他把那只旧木盒推到墙角|箱子里只剩半张泛黄的照片'],
    ['吞了一个字', '他把那只旧木箱推到墙|箱子里只剩半张泛黄的照片'],
    ['多加了字', '他把那只旧木箱推到了墙角|箱子里只剩半张泛黄的照片'],
    ['整句重写', '他把旧木箱推到角落|里面只有一张老照片'],
  ])('%s → 作废（返回 null，调用方回退机械切法）', (_label, marked) => {
    expect(cutPointsOf(SRC, marked)).toBeNull()
  })

  it('没有分隔符 → 作废（没切等于没做事）', () => {
    expect(cutPointsOf(SRC, SRC)).toBeNull()
  })

  it('切出空段 → 作废', () => {
    expect(cutPointsOf(SRC, `|${SRC}`)).toBeNull()
    expect(cutPointsOf(SRC, '他把那只旧木箱推到墙角||箱子里只剩半张泛黄的照片')).toBeNull()
  })

  /*
   * 模型很爱在标点、分隔符周围加空格。空白不是内容，去掉再比——
   * 否则会因为一个空格把一条本来正确的切分整个丢掉。
   */
  it('空白不算改字', () => {
    expect(cutPointsOf(SRC, '他把那只旧木箱推到墙角 | 箱子里只剩半张泛黄的照片')).toEqual([11])
  })
})

/** 造一个假的 DeepSeek：按脚本依次返回 */
function fakeFetch (bodies: unknown[]): typeof fetch {
  let n = 0
  return (async () => {
    const body = bodies[Math.min(n++, bodies.length - 1)]
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('两层切分', () => {
  const LONG = ['他把那只旧木箱推到墙角箱子里只剩半张泛黄的照片']

  it('第一层切好、第二层没意见 → 用第一层的', async () => {
    const r = await planCuts(LONG, {
      apiKey: 'k',
      fetch: fakeFetch([
        { cuts: [{ i: 0, text: '他把那只旧木箱推到墙角|箱子里只剩半张泛黄的照片' }] },
        { fixed: [] },
      ]),
    })
    expect(r.get(0)).toEqual([11])
  })

  it('第二层改了断点 → 用第二层的', async () => {
    const r = await planCuts(LONG, {
      apiKey: 'k',
      fetch: fakeFetch([
        { cuts: [{ i: 0, text: '他把那只旧|木箱推到墙角箱子里只剩半张泛黄的照片' }] },
        { fixed: [{ i: 0, text: '他把那只旧木箱推到墙角|箱子里只剩半张泛黄的照片' }] },
      ]),
    })
    expect(r.get(0)).toEqual([11])
  })

  /*
   * 复查失败不该把第一层的成果也赔进去——它已经过了逐字校验，是可用的。
   */
  it('第二层整个挂了 → 退回第一层，不是退回机械切法', async () => {
    let n = 0
    const flaky = (async () => {
      n++
      if (n === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ cuts: [{ i: 0, text: '他把那只旧木箱推到墙角|箱子里只剩半张泛黄的照片' }] }) } }],
        }), { status: 200 })
      }
      throw new Error('复查这一步断网了')
    }) as unknown as typeof fetch
    const r = await planCuts(LONG, { apiKey: 'k', fetch: flaky })
    expect(r.get(0)).toEqual([11])
  })

  it('第二层给的版本改了字 → 丢掉它，留第一层的', async () => {
    const r = await planCuts(LONG, {
      apiKey: 'k',
      fetch: fakeFetch([
        { cuts: [{ i: 0, text: '他把那只旧木箱推到墙角|箱子里只剩半张泛黄的照片' }] },
        { fixed: [{ i: 0, text: '他把旧木箱推到墙角|里面只剩一张照片' }] },
      ]),
    })
    expect(r.get(0)).toEqual([11])
  })

  it('第一层就改了字 → 这句根本不进结果（调用方回退机械切法）', async () => {
    const r = await planCuts(LONG, {
      apiKey: 'k',
      fetch: fakeFetch([
        { cuts: [{ i: 0, text: '他把旧木箱推到角落|里面只有一张老照片' }] },
        { fixed: [] },
      ]),
    })
    expect(r.size).toBe(0)
  })

  it('没有长句就一次都不调用', async () => {
    let called = 0
    const spy = (async () => { called++; throw new Error('不该被调用') }) as unknown as typeof fetch
    expect(await planCuts([], { apiKey: 'k', fetch: spy })).toEqual(new Map())
    expect(called).toBe(0)
  })

  it('上限是 19 字', () => {
    expect(SUBTITLE_CUT_MAX).toBe(19)
  })
})
