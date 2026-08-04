import { describe, it, expect } from 'vitest'
import { editCharacterName, renameGates, pairInconsistencies, pairNeedsYou, type CharacterReplacement } from '../../web/src/store/rename'
import type { Project } from '../../web/src/store/projects'

describe('editCharacterName —— 改新名，pairs 一起改，保持一致', () => {
  const c: CharacterReplacement = {
    original: '沈砚之', replacement: '沈屿之', role: 'protagonist',
    pairs: [
      { from: '沈砚之', to: '沈屿之', global: true },
      { from: '砚之', to: '屿之', global: true },
    ],
  }
  it('改名只动"名"那截，姓不变时 pairs 的 to 同步更新', () => {
    const r = editCharacterName(c, '沈钰之')
    expect(r.replacement).toBe('沈钰之')
    expect(r.pairs.map((p) => p.to)).toEqual(['沈钰之', '钰之'])   // 屿之→钰之
  })
  it('没变化就原样返回', () => {
    expect(editCharacterName(c, '沈屿之')).toBe(c)
  })
})

describe('renameGates —— 谁要过"先确认改名"这道门', () => {
  const base = { subtitleMode: 'karaoke', renameEnabled: true, renameState: 'proposed' } as unknown as Project
  it('文本项目 + 开 + 未确认 → 拦', () => {
    expect(renameGates(base)).toBe(true)
  })
  it('已确认 → 放行', () => {
    expect(renameGates({ ...base, renameState: 'confirmed' } as Project)).toBe(false)
  })
  it('关了改名 → 放行', () => {
    expect(renameGates({ ...base, renameEnabled: false } as Project)).toBe(false)
  })
  it('自备(line)项目 → 不拦', () => {
    expect(renameGates({ ...base, subtitleMode: 'line' } as Project)).toBe(false)
  })
  it('null → 不拦', () => {
    expect(renameGates(null)).toBe(false)
  })
})

describe('别名的一致性检查', () => {
  /*
   * "替换要统一"这条要求里，唯一能被机器检查的部分：同一个原字，
   * 在大名里换成 A、在别名里换成 B，就是不统一。
   *
   * ⚠️ 检查不到的那一半同样重要：不同源的乳名（大名沈知微、小名阿蛮）
   * 没有共享字，机器无从判断——所以别名必须摆在表里让人过目，
   * 不能全指望校验。
   */
  const person = (pairs: Array<{ from: string; to: string }>): CharacterReplacement => ({
    original: '顾文渊', replacement: '顾闻远', role: 'protagonist',
    pairs: pairs.map((p) => ({ ...p, global: true })),
  })

  it('别名和大名用同一个字 → 没问题', () => {
    const c = person([{ from: '渊儿', to: '远儿' }])
    expect(pairInconsistencies(c, 0)).toEqual([])
  })

  it('同一个字换成了不一样的 → 报出来', () => {
    const c = person([{ from: '渊儿', to: '缘儿' }])
    expect(pairInconsistencies(c, 0)).toEqual([['渊', '远', '缘']])
  })

  it('不同源的小名（没有共享字）→ 检查不到，返回空', () => {
    const c = person([{ from: '阿蛮', to: '阿曼' }])
    expect(pairInconsistencies(c, 0)).toEqual([])
  })

  it('长度不等的（加了字/漏了字）→ 不硬判，返回空', () => {
    const c = person([{ from: '渊儿', to: '远' }])
    expect(pairInconsistencies(c, 0)).toEqual([])
  })

  it('只含姓的别名（小顾）→ 姓本来就不换，没问题', () => {
    const c = person([{ from: '小顾', to: '小顾' }])
    expect(pairInconsistencies(c, 0)).toEqual([])
  })
})

describe('改不出来的小名 = 待办，不是错误', () => {
  /*
   * 用户的原话："有一些小名如果不知道改成什么但是知道是小名，就还是那样，
   * 统计出来但是先不改动，让人来做。"
   *
   * 所以 from === to 是【模型的正确行为】，不是缺陷——界面上显示"待你填"。
   * 试过用"含不含姓"去猜哪些不用改，撤了：那是在猜，而且会把"囡囡"这种
   * 真该改的判成不用改。
   */
  const gu = (from: string, to: string): CharacterReplacement => ({
    original: '顾文渊', replacement: '顾闻远', role: 'protagonist',
    pairs: [{ from, to, global: true }],
  })

  it.each([
    ['同源小名改好了', '渊儿', '远儿', false],
    ['不同源乳名没改', '阿宝', '阿宝', true],
    ['叠字乳名没改', '囡囡', '囡囡', true],
    ['只含姓的也一样交给人', '小顾', '小顾', true],
  ])('%s → 待你填=%s', (_label, from, to, want) => {
    expect(pairNeedsYou(gu(from, to), 0)).toBe(want)
  })
})
