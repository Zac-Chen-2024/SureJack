import type { RenameAnalysis, ReplacePair, CharacterReplacement } from './types.js'

/**
 * 确定性执行"去章节名 + 人名谐音替换"。**纯函数、无 IO**。
 *
 * 这是保真的落点：LLM 给指令，这里逐字执行、可核对。绝不改动指令之外的
 * 任何字符。
 *
 * 顺序（applyRename）：
 *   1. 删章节标题（整行匹配，正文不碰）
 *   2. 上下文限定的替换（单字名/易撞 token）——只在给定片段内换，防误伤
 *   3. 全局替换（全名/独特别称）——长 token 优先，避免"张三丰"里的"张三"被先换
 */

/**
 * 删章节标题：把【整行】trim 后等于某个标题串的行删掉，正文一字不动。
 *
 * 只按整行匹配、不做子串删除——标题几乎总是独占一行（"第一章 惊变"、
 * "序章"、"番外·后来"）。子串删除会误伤正文里恰好出现的同样文字。
 * 删行后相邻的多余空行折叠成一个，避免 TTS 在空行处拖长停顿。
 */
export function stripChapters (text: string, headings: string[]): string {
  if (headings.length === 0) return text
  const set = new Set(headings.map((h) => h.trim()).filter((h) => h.length > 0))
  if (set.size === 0) return text
  const kept = text.split(/\r\n|\r|\n/).filter((line) => !set.has(line.trim()))
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 在【上下文片段内】把 from 换成 to：只有 ctx 这段原样出现的地方，其中的
 * from 才被替换。用 split/join 精确限定作用域——ctx 之外的 from 一律不动。
 */
function replaceWithinContext (text: string, ctx: string, from: string, to: string): string {
  if (!ctx || !ctx.includes(from)) return text
  return text.split(ctx).join(ctx.split(from).join(to))
}

/** 把所有角色的 pairs 摊平。 */
export function flattenPairs (characters: CharacterReplacement[]): ReplacePair[] {
  return characters.flatMap((c) => c.pairs)
}

/**
 * 执行整套替换：删章节 → 上下文限定替换 → 全局替换。
 *
 * ⚠️ 全局替换按 from 长度【从长到短】：否则"沈砚之"会先被"砚之"或"沈"
 * 的规则啃掉一半。上下文替换放在全局之前，且 ctx 取自（删章节后的）原文，
 * 保证单字名的定位不被全局替换提前打乱。
 */
export function applyRename (text: string, analysis: RenameAnalysis): string {
  let out = stripChapters(text, analysis.chapterHeadings)
  const pairs = flattenPairs(analysis.characters)

  // 2. 上下文限定（global=false）——单字名/易撞 token，只在片段内换
  for (const p of pairs) {
    if (p.global) continue
    for (const ctx of p.contexts ?? []) {
      out = replaceWithinContext(out, ctx, p.from, p.to)
    }
  }

  // 3. 全局（global=true）——长 token 优先
  const globals = pairs.filter((p) => p.global).sort((a, b) => b.from.length - a.from.length)
  for (const p of globals) {
    if (!p.from) continue
    out = out.split(p.from).join(p.to)
  }
  return out
}
