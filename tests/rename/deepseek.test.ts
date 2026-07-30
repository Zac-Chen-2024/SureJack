import { describe, it, expect, vi } from 'vitest'
import {
  analyzeNovel, coerceAnalysis, extractJson, SYSTEM_PROMPT,
  hasIdentityViolation, findIdentityViolations, unchangedGivenChars, givenNameStart,
} from '../../src/rename/deepseek.js'

describe('extractJson', () => {
  it('抠出 ```json fence 里的对象', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('抠出前后有话的裸对象', () => {
    expect(extractJson('好的：{"a":1} 完毕')).toEqual({ a: 1 })
  })
  it('找不到 JSON 抛错', () => {
    expect(() => extractJson('没有对象')).toThrow()
  })
})

describe('coerceAnalysis —— 防御式收敛', () => {
  it('完整对象原样收下，缺省 global=true', () => {
    const a = coerceAnalysis({
      chapterHeadings: ['第一章'],
      characters: [{ original: '沈砚之', replacement: '沈屿之', role: 'protagonist',
        pairs: [{ from: '沈砚之', to: '沈屿之' }] }],
      relationships: [{ a: '沈砚之', b: '林晚', label: '青梅竹马' }],
    })
    expect(a.chapterHeadings).toEqual(['第一章'])
    expect(a.characters[0]!.pairs[0]!.global).toBe(true)
    expect(a.relationships[0]!.label).toBe('青梅竹马')
  })
  it('乱七八糟的输入收敛成空，不炸', () => {
    expect(coerceAnalysis(null)).toEqual({ chapterHeadings: [], characters: [], relationships: [] })
    expect(coerceAnalysis('nope')).toEqual({ chapterHeadings: [], characters: [], relationships: [] })
  })
  it('未知 role 落到 minor；无 from 的 pair 丢弃；contexts 过滤非字符串', () => {
    const a = coerceAnalysis({ characters: [{ original: '甲', role: '主角',
      pairs: [{ from: '', to: 'x' }, { from: '澜', to: '岚', global: false, contexts: ['波澜壮阔', 3] }] }] })
    expect(a.characters[0]!.role).toBe('minor')
    expect(a.characters[0]!.pairs).toHaveLength(1)
    expect(a.characters[0]!.pairs[0]!.contexts).toEqual(['波澜壮阔'])
  })
})

describe('SYSTEM_PROMPT', () => {
  it('把关键规则写进了提示词：好字、整名都换、严禁原样、只出 JSON', () => {
    expect(SYSTEM_PROMPT).toContain('漂亮的字')
    expect(SYSTEM_PROMPT).toContain('羽')
    expect(SYSTEM_PROMPT).toContain('保留姓')
    expect(SYSTEM_PROMPT).toContain('每一个字都必须换')   // 整个名都换，不是只换一个字
    expect(SYSTEM_PROMPT).toContain('严禁原样返回')        // to 不得等于 from
    expect(SYSTEM_PROMPT).toMatch(/只输出.*JSON/)
  })
})

describe('analyzeNovel', () => {
  it('带 Bearer key 调用、解析返回', async () => {
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: '{"chapterHeadings":[],"characters":[{"original":"沈砚之","replacement":"沈彦知","role":"protagonist","pairs":[{"from":"沈砚之","to":"沈彦知","global":true}]}],"relationships":[]}' } }],
    }), { status: 200 }))
    const a = await analyzeNovel('沈砚之走来。', { apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch })
    expect(fakeFetch).toHaveBeenCalledOnce()
    const init = fakeFetch.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(a.characters[0]!.replacement).toBe('沈彦知')
  })
  it('没 key 抛错', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    await expect(analyzeNovel('x')).rejects.toThrow(/DEEPSEEK_API_KEY/)
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev
  })

  it('名字原样返回时带纠正语重试一次，取第二次结果', async () => {
    const identity = { choices: [{ message: { content: '{"chapterHeadings":[],"characters":[{"original":"赵德海","replacement":"赵德海","role":"minor","pairs":[{"from":"赵德海","to":"赵德海","global":true}]}],"relationships":[]}' } }] }
    const fixed = { choices: [{ message: { content: '{"chapterHeadings":[],"characters":[{"original":"赵德海","replacement":"赵得嗨","role":"minor","pairs":[{"from":"赵德海","to":"赵得嗨","global":true}]}],"relationships":[]}' } }] }
    let n = 0
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify(n++ === 0 ? identity : fixed), { status: 200 }))
    const a = await analyzeNovel('赵德海来了。', { apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch })
    expect(fakeFetch).toHaveBeenCalledTimes(2)   // 第一次违规 → 重试
    expect(a.characters[0]!.replacement).toBe('赵得嗨')   // 取第二次
  })
})

describe('逐字校验（半吊子改名必须被抓出来）', () => {
  it('只换了一个字、中间那个原样 → 算违规（线上翻车的那种）', () => {
    // 沈砚之 → 沈屿之："之"没换。旧的整串比较会放过它，逐字比才抓得到。
    expect(unchangedGivenChars('沈砚之', '沈屿之')).toEqual(['之'])
    expect(hasIdentityViolation({ chapterHeadings: [], relationships: [], characters: [
      { original: '沈砚之', replacement: '沈屿之', role: 'protagonist', pairs: [] }] })).toBe(true)
  })
  it('姓之后每个字都换了 → 合规', () => {
    expect(unchangedGivenChars('沈砚之', '沈彦知')).toEqual([])
  })
  it('复姓：姓占两个字，只有名要换', () => {
    expect(givenNameStart('欧阳修')).toBe(2)
    expect(unchangedGivenChars('欧阳修', '欧阳秀')).toEqual([])   // 姓保留、名换了
    expect(unchangedGivenChars('欧阳修', '欧阳修')).toEqual(['修'])
  })
  it('违规条目会点名具体哪个字没换（重试时喂给模型）', () => {
    const v = findIdentityViolations({ chapterHeadings: [], relationships: [], characters: [
      { original: '赵德海', replacement: '赵德亥', role: 'minor', pairs: [] }] })
    expect(v[0]).toContain('德')
  })
})

describe('hasIdentityViolation', () => {
  it('replacement 等于 original 算违规', () => {
    expect(hasIdentityViolation({ chapterHeadings: [], relationships: [], characters: [{ original: '甲乙', replacement: '甲乙', role: 'minor', pairs: [] }] })).toBe(true)
  })
  it('pair 的 to 等于 from 算违规', () => {
    expect(hasIdentityViolation({ chapterHeadings: [], relationships: [], characters: [{ original: '甲乙', replacement: '甲丙', role: 'minor', pairs: [{ from: '乙', to: '乙', global: true }] }] })).toBe(true)
  })
  it('都换了就不违规', () => {
    expect(hasIdentityViolation({ chapterHeadings: [], relationships: [], characters: [{ original: '甲乙', replacement: '甲丙', role: 'minor', pairs: [{ from: '甲乙', to: '甲丙', global: true }] }] })).toBe(false)
  })
})
