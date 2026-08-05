import { describe, it, expect } from 'vitest'
import { homophonesOf, isHomophone, pickHomophone } from '../../src/rename/homophone.js'
import { fillStuckChars, unchangedGivenChars } from '../../src/rename/deepseek.js'
import type { RenameAnalysis } from '../../src/rename/types.js'

/*
 * 这一层存在的理由：谐音替换里"每个字都要换掉"这条，原来完全交给模型
 * （检查出没换 → 整篇重跑最多两次 → 保留最好的那一份），而"最好的"仍然
 * 可能带着一个没换的字——原名就有一半留在成片里。
 *
 * 实测（spikes/rename/）：
 *   · 整篇重跑两次都没修好"崇"；单独重试也没修好
 *   · 模型经常想不起来有哪些同音字（"知"那次没想到"之"）
 *   · 模型自述和实际不符：说"崈是异体字不能用"，然后返回了带崈的名字
 * 所以查表和落地都归代码，模型只负责挑好看的那一版。
 */
describe('同音字表', () => {
  it('常见字有一大把同音字', () => {
    expect(homophonesOf('文').sameTone.length).toBeGreaterThan(10)
    expect(homophonesOf('微').sameTone.length).toBeGreaterThan(10)
  })

  it('候选里不含它自己', () => {
    const h = homophonesOf('知')
    expect(h.sameTone).not.toContain('知')
    expect(h.sameSound).not.toContain('知')
  })

  it('同调和不同调分开给：同调优先，挑不出来才用不同调', () => {
    const h = homophonesOf('崇')
    expect(h.sameTone.length).toBeGreaterThan(0)
    for (const ch of h.sameTone) expect(isHomophone('崇', ch)).toBe(true)
    // 不同调的不算"同音"（声调不一样）
    for (const ch of h.sameSound) expect(isHomophone('崇', ch)).toBe(false)
  })

  /*
   * ⚠️【确定性】：同一个字永远挑到同一个替身。不定的话，用户什么都没改、
   * 重新分析一次名字却变了，而他完全不知道为什么。
   */
  it('挑出来的替身是稳定的', () => {
    expect(pickHomophone('文')).toBe(pickHomophone('文'))
    expect(pickHomophone('崇')).toBe(pickHomophone('崇'))
  })

  it('挑出来的一定和原字同音', () => {
    for (const ch of ['文', '渊', '微', '知', '崇', '晚']) {
      const to = pickHomophone(ch)
      expect(to).not.toBeNull()
      expect(isHomophone(ch, to!)).toBe(true)
    }
  })
})

describe('没换掉的字，代码补上', () => {
  const one = (original: string, replacement: string, pairs: Array<[string, string]>): RenameAnalysis => ({
    chapterHeadings: [],
    relationships: [],
    characters: [{
      original, replacement, role: 'protagonist',
      pairs: pairs.map(([from, to]) => ({ from, to, global: true })),
    }],
  })

  it('全名里没换的字被补上', () => {
    // 江崇桉 → 江崇安：「崇」没换
    const out = fillStuckChars(one('江崇桉', '江崇安', [['江崇桉', '江崇安']]))
    const c = out.characters[0]!
    expect(unchangedGivenChars(c.original, c.replacement)).toEqual([])
  })

  /*
   * "替换要统一"就是在这儿落实的：同一个原字在全名和所有别名里
   * 必须换成【同一个】替身，不是靠提示词求模型自觉。
   */
  it('别名里的同一个字，换成同一个替身', () => {
    const out = fillStuckChars(one('顾文渊', '顾文远', [
      ['顾文渊', '顾文远'], ['文渊', '文远'], ['渊儿', '远儿'],
    ]))
    const c = out.characters[0]!
    const to = [...c.replacement][1]!          // 「文」被换成了什么
    expect(to).not.toBe('文')
    expect(c.pairs[0]!.to).toContain(to)
    expect(c.pairs[1]!.to).toContain(to)
    // 「渊儿」里没有「文」，不该被动
    expect(c.pairs[2]!.to).toBe('远儿')
  })

  it('本来就换干净的，一个字都不动', () => {
    const src = one('顾文渊', '顾闻远', [['顾文渊', '顾闻远'], ['渊儿', '远儿']])
    expect(fillStuckChars(src)).toEqual(src)
  })

  it('姓不动', () => {
    const out = fillStuckChars(one('江崇桉', '江崇安', [['江崇桉', '江崇安']]))
    expect([...out.characters[0]!.replacement][0]).toBe('江')
  })
})
