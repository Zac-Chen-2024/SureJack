import { describe, it, expect } from 'vitest'
import { stripChapters, applyRename, flattenPairs } from '../../src/rename/replace.js'
import type { RenameAnalysis } from '../../src/rename/types.js'

describe('stripChapters', () => {
  it('整行匹配的章节标题被删，正文不动', () => {
    const t = '第一章 惊变\n沈砚之睁开眼。\n\n第二章\n他站了起来。'
    expect(stripChapters(t, ['第一章 惊变', '第二章'])).toBe('沈砚之睁开眼。\n\n他站了起来。')
  })

  it('只删整行相等的，正文里恰好出现同样文字不误删', () => {
    const t = '序章\n这一章讲的是序章之前的事。'
    // "序章" 作为标题整行被删；正文里的"序章"二字（在句中）保留
    expect(stripChapters(t, ['序章'])).toBe('这一章讲的是序章之前的事。')
  })

  it('删行后多余空行折叠', () => {
    const t = 'A\n第一章\n\n\nB'
    expect(stripChapters(t, ['第一章'])).toBe('A\n\nB')
  })

  it('没有标题时原样返回', () => {
    expect(stripChapters('正文', [])).toBe('正文')
  })
})

describe('applyRename —— 确定性替换', () => {
  const analysis: RenameAnalysis = {
    chapterHeadings: ['第一章 归来'],
    characters: [
      {
        original: '沈砚之', replacement: '沈屿之', role: 'protagonist',
        pairs: [
          { from: '沈砚之', to: '沈屿之', global: true },
          { from: '砚之', to: '屿之', global: true },
          { from: '小砚', to: '小屿', global: true },
          // 单字名"砚"易撞（砚台/砚池），只在这个上下文里换
          { from: '砚', to: '屿', global: false, contexts: ['砚哥哥'] },
        ],
      },
    ],
    relationships: [],
  }

  it('删章节 + 全名/别称替换，保留姓只换名', () => {
    const t = '第一章 归来\n沈砚之走来。砚之笑了。小砚别闹。'
    expect(applyRename(t, analysis)).toBe('沈屿之走来。屿之笑了。小屿别闹。')
  })

  it('单字名只在上下文内替换，绝不误伤同字的无关词', () => {
    const t = '砚台上落了灰。砚哥哥最好了。'
    // 砚台 的"砚"不动；砚哥哥 的"砚"→屿
    expect(applyRename(t, analysis)).toBe('砚台上落了灰。屿哥哥最好了。')
  })

  it('长 token 优先——"沈砚之"不会被"砚之"规则先啃掉', () => {
    expect(applyRename('沈砚之', analysis)).toBe('沈屿之')
  })

  it('指令之外的字符一字不动', () => {
    const t = '天气很好，风和日丽。'
    expect(applyRename(t, analysis)).toBe('天气很好，风和日丽。')
  })

  it('flattenPairs 摊平所有角色的替换对', () => {
    expect(flattenPairs(analysis.characters)).toHaveLength(4)
  })
})
