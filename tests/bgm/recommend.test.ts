import { describe, it, expect } from 'vitest'
import { coerceBgmPick, recommendBgm, BGM_SYSTEM_PROMPT } from '../../src/bgm/recommend.js'

const CHOICES = [
  { id: 'a', filename: '一笑倾城 现言 甜文.wav' },
  { id: 'b', filename: '若梦 古言 虐文.wav' },
  { id: 'c', filename: '非虐文通用.wav' },
]

describe('配乐推荐的收拢', () => {
  it('正常返回', () => {
    expect(coerceBgmPick({ id: 'b', reason: '古装虐文' }, CHOICES))
      .toEqual({ id: 'b', reason: '古装虐文' })
  })

  /*
   * 【id 必须在清单里】。模型偶尔把文件名当 id 回、或者自己编一个。
   * 不校验就会写进 bgmLibraryId，合成时找不到这首曲子——表现是
   * "成片没有背景音乐"，而没人会想到是配乐推荐写坏了一个 id。
   */
  it('清单里没有的 id 一律丢掉', () => {
    expect(coerceBgmPick({ id: '若梦 古言 虐文.wav' }, CHOICES)).toBeNull()
    expect(coerceBgmPick({ id: '不存在' }, CHOICES)).toBeNull()
    expect(coerceBgmPick({}, CHOICES)).toBeNull()
  })

  it('没写理由时给一句占位', () => {
    expect(coerceBgmPick({ id: 'a' }, CHOICES)?.reason).not.toBe('')
  })
})

describe('提示词', () => {
  /* 古装故事配现代情歌是最刺耳的错误，这一条必须写在提示词里 */
  it('把朝代背景排在情绪之前', () => {
    expect(BGM_SYSTEM_PROMPT).toContain('先看朝代背景')
    expect(BGM_SYSTEM_PROMPT).toContain('古装故事配现代情歌')
  })
})

describe('调用', () => {
  it('清单为空时直接返回 null，不发请求', async () => {
    let called = false
    const r = await recommendBgm('故事', [], {
      apiKey: 'k',
      fetch: (async () => { called = true; throw new Error('不该被调用') }) as unknown as typeof fetch,
    })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })

  it('只把开头 800 字发过去，不发全文', async () => {
    let sent = ''
    await recommendBgm('字'.repeat(5000), CHOICES, {
      apiKey: 'k',
      fetch: (async (_u: string, init: { body: string }) => {
        sent = init.body
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"id":"a","reason":"x"}' } }] }),
        }
      }) as unknown as typeof fetch,
    })
    const userMsg = JSON.parse(sent).messages[1].content as string
    expect(userMsg.length).toBeLessThan(2000)
  })
})
