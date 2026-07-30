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
 * 删掉"非正文内容"（章节标题、【作者有话说】、分隔线、站点水印…由 API-1 判定）。
 *
 * 两种删法，都【只在行的边界上动手】，正文一字不改：
 *   ① 整行命中 → 整行删掉（"第一章 惊变"独占一行的常见情况）。
 *   ② 出现在行【开头】→ 只删这一截（"【第一章】他回来了" → "他回来了"）。
 *      这条是必需的：线上真实翻车过——方括号标注内联在段首，只做整行匹配
 *      就漏了，于是"第一章"三个字被念进配音、还显示在字幕上。
 *
 * 【故意不做任意位置的子串删除】：那会误伤正文里恰好出现同样文字的地方
 * （比如正文里讲"这一章"）。只认行首/整行，是保真与去噪之间的正确取舍。
 * 删完把多余空行折叠，免得 TTS 在空行处拖出长停顿。
 */
export function stripChapters (text: string, headings: string[]): string {
  if (headings.length === 0) return text
  const marks = headings.map((h) => h.trim()).filter((h) => h.length > 0)
  if (marks.length === 0) return text
  const exact = new Set(marks)
  // 长的先试，避免短的先啃掉一半（"【第一章】" vs "第一章"）
  const byLongest = [...marks].sort((a, b) => b.length - a.length)

  const kept: string[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (exact.has(line)) continue          // ① 整行就是要删的
    let out = line
    for (const m of byLongest) {           // ② 出现在行首 → 只削掉这一截
      if (out.startsWith(m)) { out = out.slice(m.length).trim(); break }
    }
    kept.push(out)
  }
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
