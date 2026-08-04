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

/** 第二层复查（API-2）的结果：捞到的漏网非正文 + 可能的残留原名 */
export interface ReviewResult { removeLines: string[]; leftoverNames: string[] }

/** 从项目的 renameAnalysisJson 里取出复查结果与错误（供展示 + 重试） */
export function readReview (analysisJson: string | null): { review: ReviewResult | null; error: string | null } {
  if (!analysisJson) return { review: null, error: null }
  try {
    const o = JSON.parse(analysisJson) as { review?: ReviewResult | null; reviewError?: string | null }
    return { review: o?.review ?? null, error: o?.reviewError ?? null }
  } catch { return { review: null, error: null } }
}

interface RenameState {
  /** 可编辑的工作副本；null = 还没分析 */
  draft: RenameAnalysis | null
  busy: boolean
  error: string | null
  /** 哪一步在忙 / 哪一步失败了——决定重试按钮长在哪 */
  step: 'analyze' | 'confirm' | 'review' | null
  /** 重跑第二层复查（清理漏网的章节号等）。失败会写进 error，可反复重试 */
  retryReview: (id: string) => Promise<void>
  /** 从项目已存的映射恢复草稿（切项目 / 首次进面板时） */
  hydrate: (project: Project | null) => void
  analyze: (id: string) => Promise<void>
  editReplacement: (index: number, newReplacement: string) => void
  /** 单独改一条别名的新串。别名不一定和大名同源（乳名「阿蛮」），必须能单独改 */
  editPair: (charIndex: number, pairIndex: number, to: string) => void
  /** 删掉一条别名。模型偶尔会把身份称谓、甚至别的词当成名字 */
  removePair: (charIndex: number, pairIndex: number) => void
  confirm: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  reset: () => void
}

export const useRename = create<RenameState>((set, get) => ({
  draft: null, busy: false, error: null, step: null,

  hydrate (project) {
    set({ draft: parseMap(project?.renameMapJson ?? null), error: null })
  },

  async analyze (id) {
    set({ busy: true, error: null, step: 'analyze' })
    try {
      const { analysis } = await api.post<{ analysis: RenameAnalysis }>(`/api/projects/${id}/rename/analyze`)
      set({ draft: analysis })
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '人名分析失败' })
    } finally {
      set({ busy: false, step: null })
    }
  },

  editPair (charIndex, pairIndex, to) {
    const d = get().draft
    if (!d) return
    set({
      draft: {
        ...d,
        characters: d.characters.map((c, i) => (i !== charIndex ? c : {
          ...c,
          pairs: c.pairs.map((p, j) => (j === pairIndex ? { ...p, to } : p)),
        })),
      },
    })
  },

  removePair (charIndex, pairIndex) {
    const d = get().draft
    if (!d) return
    set({
      draft: {
        ...d,
        characters: d.characters.map((c, i) => (i !== charIndex ? c : {
          ...c, pairs: c.pairs.filter((_, j) => j !== pairIndex),
        })),
      },
    })
  },

  editReplacement (index, newReplacement) {
    const d = get().draft
    if (!d) return
    const characters = d.characters.map((c, i) => (i === index ? editCharacterName(c, newReplacement) : c))
    set({ draft: { ...d, characters } })
  },

  async confirm (id) {
    const d = get().draft
    set({ busy: true, error: null, step: 'confirm' })
    try {
      await api.post(`/api/projects/${id}/rename/confirm`, { analysis: d })
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '确认失败' })
    } finally {
      set({ busy: false, step: null })
    }
  },

  /*
   * 重跑第二层复查。用途：某次 DeepSeek 抽风/超时导致漏网内容没清掉（比如
   * 孤立的章节号数字行），点一下就能重来，不用整条流程从头走。
   */
  async retryReview (id) {
    set({ busy: true, error: null, step: 'review' })
    try {
      await api.post(`/api/projects/${id}/rename/review`)
      await useProjects.getState().load()
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '清理复查失败' })
    } finally {
      set({ busy: false, step: null })
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

/**
 * 一个角色名下的【不一致】：同一个原字，在大名里换成 A、在别名里换成 B。
 *
 * ⚠️ 这是"替换要统一"这条要求唯一能被机器检查的部分。不同源的小名
 * （大名沈知微、乳名阿蛮）没有共享字，检查不到，那种只能靠人过目——
 * 所以别名要摆在表里让人看见，不能全指望校验。
 *
 * 返回 [原字, 大名里换成什么, 这条别名里换成什么][]
 */
/**
 * 这条别名还没填新名（from === to）。
 *
 * ⚠️【这不是错误，是待办】。模型知道"囡囡"是乳名、但和大名不同源，
 * 想不出该换成什么——这时它的正确行为就是【原样列出来交给人】，
 * 而不是硬编一个。所以界面上要显示成"待你填"，不是"⚠ 没换"。
 *
 * 试过用"含不含姓"来猜哪些不用改（小顾、沈二姑娘），撤了：那是在猜，
 * 而且会把"囡囡"这种真该改的判成不用改。判断交给人，机器只负责标出来。
 */
export function pairNeedsYou (c: CharacterReplacement, pairIndex: number): boolean {
  const pair = c.pairs[pairIndex]
  return pair !== undefined && pair.to === pair.from
}

export function pairInconsistencies (
  c: CharacterReplacement, pairIndex: number,
): Array<[string, string, string]> {
  const main = charSubstitutions(c.original, c.replacement)
  const pair = c.pairs[pairIndex]
  if (pair === undefined) return []
  const here = charSubstitutions(pair.from, pair.to)
  const bad: Array<[string, string, string]> = []
  for (const [ch, to] of here) {
    const expect = main.get(ch)
    if (expect !== undefined && expect !== to) bad.push([ch, expect, to])
  }
  return bad
}

/** 等长的两串 → 逐字映射。长度不同就算不出来（谐音替换本来就是等长的） */
function charSubstitutions (from: string, to: string): Map<string, string> {
  const a = [...from]; const b = [...to]
  const m = new Map<string, string>()
  if (a.length !== b.length) return m
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i]
    if (x !== undefined && y !== undefined && x !== y) m.set(x, y)
  }
  return m
}
