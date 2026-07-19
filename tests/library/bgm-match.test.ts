import { describe, it, expect } from 'vitest'
import { classifyScript, tagsOf, pickBgm } from '../../src/library/bgm-match.js'

/** 库里 9 首的真实文件名——所有边界都来自它们，不是编的 */
const REAL = [
  '一笑倾城 现言 甜文.wav',
  '傻女 现言.wav',
  '大女主 爽文.wav',
  '悬溺 现言.wav',
  '苏公堤 古言 甜文.wav',
  '若梦 古言 虐文.wav',
  '虐心回忆文.wav',
  '重生非甜文通用(1).mp3',
  '非虐文通用.wav',
].map((filename, i) => ({ id: `b${i}`, filename }))

describe('tagsOf —— 真实文件名的脏情况', () => {
  it('规规矩矩的：曲名 + 空格分隔标签', () => {
    const t = tagsOf('一笑倾城 现言 甜文.wav')
    expect(t.era).toBe('现言')
    expect(t.tones).toEqual(['甜文'])
    expect(t.generic).toBe(false)
  })

  /* 这首没有空格，按空格切会解出零个标签、永远匹配不上任何文案 */
  it('没有空格的「虐心回忆文」也能识别出虐文', () => {
    const t = tagsOf('虐心回忆文.wav')
    expect(t.tones).toEqual(['虐文'])
    expect(t.era).toBeNull()
  })

  /*
   * 这两首最危险：文件名里含「甜文」「虐文」，但前面有个「非」。
   * 按正向读会给虐文配上一首明确标着「非虐文」的曲子。
   */
  it('「非虐文通用」是反向标签，不是正向', () => {
    const t = tagsOf('非虐文通用.wav')
    expect(t.notTones).toEqual(['虐文'])
    expect(t.tones).toEqual([])
    expect(t.generic).toBe(true)
  })

  it('「重生非甜文通用(1)」——反向标签 + 数字后缀', () => {
    const t = tagsOf('重生非甜文通用(1).mp3')
    expect(t.notTones).toEqual(['甜文'])
    expect(t.tones).toEqual([])
    expect(t.generic).toBe(true)
  })
})

describe('classifyScript', () => {
  /*
   * 【绝不用单字关键词】。第一版用「亲」统计甜文，豪门那篇 38 个「亲」
   * 里有 26 个是「亲爸」「亲妈」「亲生」，一个亲吻都没有，甜文分虚高三倍。
   */
  it('「亲爸亲妈亲生」不该被算成甜文', () => {
    const g = classifyScript('我被亲生父母找回那天，亲爸亲妈哭得像丢了三头猪。'.repeat(10))
    expect(g.scores['甜文']).toBe(0)
  })

  it('现代题材判现言', () => {
    const g = classifyScript('网恋对象发来微信，我掏出手机，公司老板打电话过来。')
    expect(g.era).toBe('现言')
  })

  it('古装题材判古言', () => {
    const g = classifyScript('皇上驾到，娘娘接旨，王爷与丞相在府里议事，太子殿下也来了。')
    expect(g.era).toBe('古言')
  })

  /* 一个「大人」不足以把现代剧判成古装——证据不足时判现代，错得更轻 */
  it('零星古风词不足以翻案', () => {
    const g = classifyScript('大人您好。我用手机给公司老板发了微信，又打了电话。')
    expect(g.era).toBe('现言')
  })
})

describe('pickBgm —— 真实文案的三个案例', () => {
  it('现言甜文 → 一笑倾城（时代和基调都命中）', () => {
    const text = '网恋对象的嘴巴很毒，但他的室友很温柔。我用手机给他发消息，他总是宠着我，喜欢陪我。'
    const r = pickBgm(text, REAL)
    expect(r.chosen?.filename).toBe('一笑倾城 现言 甜文.wav')
  })

  /*
   * 现言虐文最容易选错：库里唯一标着「虐文」的是「若梦 古言 虐文」，
   * 不给时代冲突扣分的话，它会靠基调分压过没有时代标签的「虐心回忆文」，
   * 给现代剧配上古风曲。第一版就是这么错的。
   */
  it('现言虐文不能选到古言的曲子', () => {
    const text = '我用手机看着他的朋友圈，眼泪掉下来。他背叛了我，还骗我说会陪我。医院里我一个人。'
    const r = pickBgm(text, REAL)
    expect(r.chosen?.filename).toBe('虐心回忆文.wav')
  })

  it('明确标着「非X」的曲子，绝不配给 X 类文案', () => {
    const text = '眼泪、背叛、失去、绝症、车祸、哭着、离开我、抛弃、痛苦、恨我。'.repeat(3)
    const r = pickBgm(text, REAL)
    expect(r.chosen?.filename).not.toBe('非虐文通用.wav')
  })

  /* 同一篇文案每次挑出来必须是同一首，否则用户重新导出配乐就变了 */
  it('确定性：同一文案挑 50 次结果一致', () => {
    const text = '网恋对象很温柔，我喜欢他，他宠着我。'
    const first = pickBgm(text, REAL).chosen?.filename
    for (let i = 0; i < 50; i++) {
      expect(pickBgm(text, REAL).chosen?.filename).toBe(first)
    }
  })

  it('候选为空时返回 null 而不是崩', () => {
    const r = pickBgm('随便什么文案', [])
    expect(r.chosen).toBeNull()
  })
})
