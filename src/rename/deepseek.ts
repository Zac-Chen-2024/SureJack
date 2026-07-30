import type { RenameAnalysis, CharacterReplacement, ReplacePair, Relationship, CharacterRole } from './types.js'
import { EMPTY_ANALYSIS } from './types.js'

/**
 * 调 DeepSeek 做 API-1：去章节名 + 人名/关系/谐音分析。
 *
 * ⚠️ 它【只产出替换指令】（RenameAnalysis），不产出改好的文本——执行交给
 * replace.ts 确定性完成。这样才守得住保真。
 *
 * key 从环境变量 DEEPSEEK_API_KEY 读；fetch 可注入，便于测试不打真网。
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

export interface AnalyzeDeps {
  apiKey?: string
  fetch?: typeof fetch
  /** 超时毫秒，缺省 60s（整本小说分析可能偏慢） */
  timeoutMs?: number
}

/** 系统提示词：把规则写死，尤其"主角相关用好字"和"只出 JSON"。 */
export const SYSTEM_PROMPT = `你是中文小说的人名与关系分析器，服务于"营销号短视频"的改名需求。
给你一段小说正文，你【只输出一个 JSON 对象】，不要任何解释、不要 markdown 代码块。

任务：
1. chapterHeadings：找出所有【章节/卷标题】（如"第一章 惊变""序章""番外·后来""楔子"等，
   通常独占一行），把这些标题的【原文串】原样列进数组。绝不改动正文内容，只是把标题挑出来。
2. characters：抽取所有人物，每个人物给出：
   - original：原全名（如"沈砚之"）。
   - role：主角=protagonist，与主角关系密切者=related，其余=minor。
   - replacement：改名后的全名。规则：【保留姓、只换名】，用【谐音字】。
     * 主角与主角相关(protagonist/related)：谐音要用【漂亮的字】。例如读音 yu 不要用"雨"，
       改用"羽""郁""钰""屿"这类雅字；读音 lan 用"澜""岚"而非"篮"。
     * 配角(minor)：普通谐音即可。
   - pairs：该人物名下所有需要替换的 token → 新串。包含：全名、单独的名（去掉姓）、
     小名/昵称/称呼中属于【名字】的部分（排除"少爷/学长/师父/大人"这类身份称谓，那些不换）。
     同一人物的所有 token 必须映射到【一致】的新名。每个 pair：
       { "from": 原串, "to": 新串,
         "global": 是否可全局替换,
         "contexts": 若 global=false 才给——原文里包含该 from、足以定位它的片段(数组) }
     * global=true：全名、或独特的多字别称（撞词概率低）。
     * global=false：单字名、或容易撞进无关词的短 token（如"砚"会撞"砚台"）。
       这时必须给 contexts：几段原文里确实出现、且能唯一定位这个名字用法的片段，
       代码只会在这些片段内替换，避免误伤。
3. relationships：人物之间的关系边，数组，每条 { "a": 原名, "b": 原名, "label": 关系(如"父女""宿敌") }。

输出 JSON 形如：
{"chapterHeadings":[],"characters":[{"original":"","replacement":"","role":"protagonist","pairs":[{"from":"","to":"","global":true}]}],"relationships":[{"a":"","b":"","label":""}]}`

function buildUserPrompt (novel: string): string {
  return `下面是小说正文，按上述规则分析并只输出 JSON：\n\n${novel}`
}

const ROLES: CharacterRole[] = ['protagonist', 'related', 'minor']

/** 防御式收敛任意对象到 RenameAnalysis——LLM 偶尔多给/少给字段都不该炸。 */
export function coerceAnalysis (raw: unknown): RenameAnalysis {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY_ANALYSIS }
  const o = raw as Record<string, unknown>
  const chapterHeadings = Array.isArray(o.chapterHeadings)
    ? o.chapterHeadings.filter((x): x is string => typeof x === 'string')
    : []
  const characters: CharacterReplacement[] = Array.isArray(o.characters)
    ? o.characters.map(coerceCharacter).filter((c): c is CharacterReplacement => c !== null)
    : []
  const relationships: Relationship[] = Array.isArray(o.relationships)
    ? o.relationships.flatMap((r) => {
      if (r === null || typeof r !== 'object') return []
      const rr = r as Record<string, unknown>
      if (typeof rr.a !== 'string' || typeof rr.b !== 'string') return []
      return [{ a: rr.a, b: rr.b, label: typeof rr.label === 'string' ? rr.label : '' }]
    })
    : []
  return { chapterHeadings, characters, relationships }
}

function coerceCharacter (raw: unknown): CharacterReplacement | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.original !== 'string' || o.original.length === 0) return null
  const role: CharacterRole = ROLES.includes(o.role as CharacterRole) ? o.role as CharacterRole : 'minor'
  const pairs: ReplacePair[] = Array.isArray(o.pairs)
    ? o.pairs.flatMap((p) => {
      if (p === null || typeof p !== 'object') return []
      const pp = p as Record<string, unknown>
      if (typeof pp.from !== 'string' || typeof pp.to !== 'string' || pp.from.length === 0) return []
      const global = pp.global !== false   // 缺省当全局
      const contexts = Array.isArray(pp.contexts)
        ? pp.contexts.filter((x): x is string => typeof x === 'string')
        : undefined
      return [{ from: pp.from, to: pp.to, global, ...(contexts ? { contexts } : {}) }]
    })
    : []
  const replacement = typeof o.replacement === 'string' ? o.replacement : o.original
  return { original: o.original, replacement, role, pairs }
}

/** 从 LLM 文本里抠出 JSON（容忍它偶尔包了 ```json fence 或前后有话）。 */
export function extractJson (content: string): unknown {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1]! : content
  const s = body.indexOf('{'); const e = body.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) throw new Error('DeepSeek 返回里找不到 JSON')
  return JSON.parse(body.slice(s, e + 1))
}

export async function analyzeNovel (novel: string, deps: AnalyzeDeps = {}): Promise<RenameAnalysis> {
  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，无法做人名分析')
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 60_000)
  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(novel) },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`人名分析失败（DeepSeek ${res.status}）`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('DeepSeek 返回为空')
    return coerceAnalysis(extractJson(content))
  } finally {
    clearTimeout(timer)
  }
}
