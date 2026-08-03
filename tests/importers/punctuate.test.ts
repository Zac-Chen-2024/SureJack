import { describe, it, expect } from 'vitest'
import {
  checkPunctuation, punctuate, bareText, PUNCT_CHARS_PER_MARK,
} from '../../src/importers/punctuate.js'

/** 造一段正常网文：每 10 字一个标点（实测真实值就是这个量级） */
const NORMAL = Array.from({ length: 40 }, (_, i) => `这是第${i}段正常的话`).join('。') + '。'
/** 造一段流水账：三百多字一个标点都没有 */
const RAW = '他推开门走进屋子里看见桌上放着一封信'.repeat(20)

describe('标点体检', () => {
  it('正常文本判健康（一次 API 都不该调）', () => {
    const h = checkPunctuation(NORMAL)
    expect(h.healthy).toBe(true)
    expect(h.density).toBeLessThan(PUNCT_CHARS_PER_MARK)
  })

  it('整段没标点判异常', () => {
    const h = checkPunctuation(RAW)
    expect(h.healthy).toBe(false)
    expect(h.density).toBe(Number.POSITIVE_INFINITY)
  })

  /*
   * 一句话的测试文案本来就可能没标点。为它调一次 API 毫无意义，
   * 还会让所有短文案的新建流程凭空多等几秒。
   */
  it('太短的一律算健康，不折腾', () => {
    expect(checkPunctuation('他推开门走进屋子').healthy).toBe(true)
  })

  it('健康的文本 punctuate 直接返回 null，不发请求', async () => {
    let called = 0
    const spy = (async () => { called++; throw new Error('不该被调用') }) as unknown as typeof fetch
    expect(await punctuate(NORMAL, { apiKey: 'k', fetch: spy })).toBeNull()
    expect(called).toBe(0)
  })
})

function reply (text: string): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ text }) } }],
  }), { status: 200 })) as unknown as typeof fetch
}

describe('补标点：只能加标点，不能改字', () => {
  const SRC = '他推开门走进屋子看见桌上放着一封信'.repeat(15)

  it('只加标点 → 采用', async () => {
    const fixed = SRC.replace(/屋子/g, '屋子，')
    expect(await punctuate(SRC, { apiKey: 'k', fetch: reply(fixed) })).toBe(fixed)
  })

  it.each([
    ['改了字', '他推开房门走进屋子，看见桌上放着一封信'.repeat(15)],
    ['吞了字', '他推开门走进屋子，看见桌上放着信'.repeat(15)],
    ['顺手润色', '他推开门，走进屋子，只见桌上静静放着一封信'.repeat(15)],
  ])('%s → 整篇作废，返回 null（调用方原样用旧文本）', async (_label, bad) => {
    expect(await punctuate(SRC, { apiKey: 'k', fetch: reply(bad) })).toBeNull()
  })

  it('接口挂了也返回 null，不抛异常', async () => {
    const boom = (async () => { throw new Error('断网') }) as unknown as typeof fetch
    expect(await punctuate(SRC, { apiKey: 'k', fetch: boom })).toBeNull()
  })

  it('bareText 把标点和空白都剥掉', () => {
    expect(bareText('他说：“好。”\n走了')).toBe('他说好走了')
  })
})
