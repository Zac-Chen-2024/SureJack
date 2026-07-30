import { describe, it, expect, vi } from 'vitest'
import { analyzeNovel, coerceAnalysis, extractJson, SYSTEM_PROMPT } from '../../src/rename/deepseek.js'

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
  it('把"好字"规则和"只出 JSON"写进了提示词', () => {
    expect(SYSTEM_PROMPT).toContain('漂亮的字')
    expect(SYSTEM_PROMPT).toContain('羽')
    expect(SYSTEM_PROMPT).toContain('保留姓')
    expect(SYSTEM_PROMPT).toMatch(/只输出.*JSON/)
  })
})

describe('analyzeNovel', () => {
  it('带 Bearer key 调用、解析返回', async () => {
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: '{"chapterHeadings":[],"characters":[{"original":"沈砚之","replacement":"沈屿之","role":"protagonist","pairs":[{"from":"沈砚之","to":"沈屿之","global":true}]}],"relationships":[]}' } }],
    }), { status: 200 }))
    const a = await analyzeNovel('沈砚之走来。', { apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch })
    expect(fakeFetch).toHaveBeenCalledOnce()
    const init = fakeFetch.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(a.characters[0]!.replacement).toBe('沈屿之')
  })
  it('没 key 抛错', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    await expect(analyzeNovel('x')).rejects.toThrow(/DEEPSEEK_API_KEY/)
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev
  })
})
