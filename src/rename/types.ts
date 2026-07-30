/**
 * 人名谐音替换 —— 数据结构。
 *
 * 设计铁律（见 /.claude/plans/text-rename-homophone.md）：**LLM 只产出这份
 * "替换指令"，真正的删章节/换名由代码（replace.ts）确定性执行**。绝不让
 * LLM 整篇改写——那会 drift、漏字、幻觉。所以这里的每一条都是可逐字核对
 * 的指令，不是"改好的文本"。
 */

/** 角色分级：主角 / 主角相关 / 配角。决定谐音是否用"好字"。 */
export type CharacterRole = 'protagonist' | 'related' | 'minor'

/**
 * 一条确定性替换。
 *
 * `global=true`：全名或独特的多字别称，撞词概率低 → 全局替换。
 * `global=false`：单字名或易撞的短 token → **只在 contexts 给出的上下文
 *   片段里替换**，避免把"李"换进"行李"这种误伤。contexts 是原文里确实
 *   出现、足以定位该 token 的片段。
 */
export interface ReplacePair {
  from: string
  to: string
  global: boolean
  contexts?: string[]
}

/** 一个角色：原名 + 分级 + 它名下所有 token 的替换对（全名/单名/小名/称呼）。 */
export interface CharacterReplacement {
  /** 原全名，作为前端分组标题与关系图节点 id */
  original: string
  /** 替换后的全名（保留姓、只换名），前端展示用 */
  replacement: string
  role: CharacterRole
  /** 这个角色所有要替换的 token（已含全名/单名/别称），供 replace.ts 执行 */
  pairs: ReplacePair[]
}

/** 关系边，给前端画关系图 */
export interface Relationship {
  a: string        // 原名（CharacterReplacement.original）
  b: string
  label: string    // 如 "父女" "宿敌" "青梅竹马"
}

/** API-1 的完整产出：去章节 + 人名/谐音 + 关系。 */
export interface RenameAnalysis {
  /** 要整行删除的章节/卷标题（原文串），正文不动 */
  chapterHeadings: string[]
  characters: CharacterReplacement[]
  relationships: Relationship[]
}

/** 空分析（改名关闭 / 还没分析时的占位） */
export const EMPTY_ANALYSIS: RenameAnalysis = {
  chapterHeadings: [], characters: [], relationships: [],
}
