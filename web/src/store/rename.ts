import { create } from 'zustand'
import { api, ApiError } from '../api/client'
import { useProjects, type Project } from './projects'

/**
 * 人名谐音替换的前端状态。类型镜像后端 src/rename/types.ts（web 是独立 TS
 * 工程、不能跨目录 import，只能各存一份，和 projects.ts 里 VOICES 同约定）。
 */
export type CharacterRole = 'protagonist' | 'related' | 'minor'
export interface ReplacePair { from: string; to: string; global: boolean; contexts?: string[] }
export interface CharacterReplacement {
  original: string; replacement: string; role: CharacterRole; pairs: ReplacePair[]
}
export interface Relationship { a: string; b: string; label: string }
export interface RenameAnalysis {
  chapterHeadings: string[]; characters: CharacterReplacement[]; relationships: Relationship[]
}

/**
 * 用户改某个角色的「新名」时，把该角色所有 token 的 to 一起改掉，保持一致。
 *
 * 只让用户编辑一个字段（新全名），而 pairs 是逐 token 的——所以要把
 * 旧新名里【姓之后那截（名）】的差异，映射到每个 pair.to 上。取旧新名的
 * 公共前缀当"没动的姓"，把旧名部分整体换成新名部分。纯函数，好测。
 */
export function editCharacterName (c: CharacterReplacement, newReplacement: string): CharacterReplacement {
  const old = c.replacement
  if (newReplacement === old) return c
  let p = 0
  while (p < old.length && p < newReplacement.length && old[p] === newReplacement[p]) p++
  const oldGiven = old.slice(p)
  const newGiven = newReplacement.slice(p)
  const pairs = oldGiven.length === 0
    ? c.pairs
    : c.pairs.map((pair) => ({ ...pair, to: pair.to.split(oldGiven).join(newGiven) }))
  return { ...c, replacement: newReplacement, pairs }
}

function parseMap (json: string | null): RenameAnalysis | null {
  if (!json) return null
  try {
    const o = JSON.parse(json) as Partial<RenameAnalysis>
    if (!Array.isArray(o?.characters)) return null
    return {
      chapterHeadings: Array.isArray(o.chapterHeadings) ? o.chapterHeadings : [],
      characters: o.characters as CharacterReplacement[],
      relationships: Array.isArray(o.relationships) ? o.relationships : [],
    }
  } catch { return null }
}

/** 文本项目是否要过"先确认改名"这道门 */
export function renameGates (p: Project | null): boolean {
  return !!p && p.renameEnabled && p.subtitleMode !== 'line' && p.renameState !== 'confirmed'
}

interface RenameState {
  /** 可编辑的工作副本；null = 还没分析 */
  draft: RenameAnalysis | null
  busy: boolean
  error: string | null
  /** 从项目已存的映射恢复草稿（切项目 / 首次进面板时） */
  hydrate: (project: Project | null) => void
  analyze: (id: string) => Promise<void>
  editReplacement: (index: number, newReplacement: string) => void
  confirm: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  reset: () => void
}

export const useRename = create<RenameState>((set, get) => ({
  draft: null, busy: false, error: null,

  hydrate (project) {
    set({ draft: parseMap(project?.renameMapJson ?? null), error: null })
  },

  async analyze (id) {
    set({ busy: true, error: null })
    try {
      const { analysis } = await api.post<{ analysis: RenameAnalysis }>(`/api/projects/${id}/rename/analyze`)
      set({ draft: analysis })
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '人名分析失败' })
    } finally {
      set({ busy: false })
    }
  },

  editReplacement (index, newReplacement) {
    const d = get().draft
    if (!d) return
    const characters = d.characters.map((c, i) => (i === index ? editCharacterName(c, newReplacement) : c))
    set({ draft: { ...d, characters } })
  },

  async confirm (id) {
    const d = get().draft
    set({ busy: true, error: null })
    try {
      await api.post(`/api/projects/${id}/rename/confirm`, { analysis: d })
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '确认失败' })
    } finally {
      set({ busy: false })
    }
  },

  async toggle (id, enabled) {
    set({ busy: true, error: null })
    try {
      await api.post(`/api/projects/${id}/rename/toggle`, { enabled })
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '切换失败' })
    } finally {
      set({ busy: false })
    }
  },

  reset () { set({ draft: null, busy: false, error: null }) },
}))
