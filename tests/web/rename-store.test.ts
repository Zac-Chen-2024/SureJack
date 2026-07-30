import { describe, it, expect } from 'vitest'
import { editCharacterName, renameGates, type CharacterReplacement } from '../../web/src/store/rename'
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
