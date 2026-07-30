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
1. chapterHeadings：找出所有【不该出现在视频里的非正文内容】，把它们的【原文串】原样列进数组。
   这不只是章节标题，而是所有"不是故事本身"的东西：
     · 章节/卷标题：第一章 惊变、序章、楔子、番外·后来、Chapter 3、【第一章】…
     · 方括号/书名号包起来的标注：【作者有话说】、（未完待续）、[本章完]
     · 作者的话、求收藏求月票、更新公告
     · 分隔线与装饰：——————、***、===
     · 站点水印/来源：本文首发于XXX、请记住本站网址、XX小说网
   这些内容会被【整行删除】，或当它出现在某行【开头】时把这一截删掉
   （例如"【第一章】他回来了"→"他回来了"）。所以请把要删的那一截【原样、完整】给出。
   ⚠️ 绝不改动正文本身，只是把这些"非正文"挑出来。宁可漏挑，也不要把正文当成标注。
2. characters：抽取所有人物，每个人物给出：
   - original：原全名（如"沈砚之"）。
   - role：主角=protagonist，与主角关系密切者=related，其余=minor。
   - replacement：改名后的全名。规则：
     * 【保留姓】；姓之后【名字的每一个字都必须换掉】，换成读音相同或相近、但【字不同】
       的谐音字。整个名都要变，不是只换一个字。
       例：沈砚之 → 沈彦知（砚 yàn→彦，之 zhī→知）；林晚 → 林婉（晚 wǎn→婉）；
       苏文轩 → 苏雯萱（文→雯，轩→萱）。
     * 【严禁原样返回，配角也不例外】：任何角色（含配角）的 replacement 都【绝不能等于】
       original，每个 pair 的 to 也绝不能等于 from——姓可相同，名里【每一个字都要换成
       另一个读音相同的字（谐音字）】。中文几乎每个字都有同音字，务必找出来，不许偷懒
       原样返回；也【不要用近音字凑】，就用【读音完全相同】的字。
     * 主角与主角相关(protagonist/related)：谐音挑【漂亮的字】。例如读音 yu 用"羽/郁/钰/屿"
       而非"雨"；zhi 用"知/芷/织"而非"之"；lan 用"澜/岚"而非"篮"。配角(minor)：普通谐音即可。
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

/** 常见复姓。判"姓占几个字"用——姓要保留，名必须逐字换掉。 */
const COMPOUND_SURNAMES = [
  '欧阳', '司马', '上官', '夏侯', '诸葛', '闻人', '东方', '赫连', '皇甫', '尉迟',
  '公羊', '澹台', '公孙', '轩辕', '令狐', '宇文', '长孙', '慕容', '司徒', '司空',
  '独孤', '南宫', '万俟', '拓跋', '第五', '呼延',
]

/** "名"从第几个字开始（姓之后）。复姓算 2 字，否则 1 字。 */
export function givenNameStart (name: string): number {
  return COMPOUND_SURNAMES.some((s) => name.startsWith(s)) ? 2 : 1
}

/**
 * 找出"名字没换干净"的字：姓之后【同一位置仍是同一个字】的都算。
 *
 * 这条是必需的——线上翻车过：模型返回 沈砚之 → 沈砚知，只换了最后一个字，
 * 中间的"砚"原样留着。而旧的校验只比整串是否相等（沈砚之 ≠ 沈砚知 → 通过），
 * 于是这种半吊子改名被放过去了。必须逐字比。
 */
export function unchangedGivenChars (original: string, replacement: string): string[] {
  const a = [...original], b = [...replacement]
  const out: string[] = []
  for (let i = givenNameStart(original); i < a.length && i < b.length; i++) {
    if (a[i] === b[i]) out.push(a[i]!)
  }
  return out
}

/**
 * 有没有违规：① 整名原样；② 任一 pair 的 to 等于 from；
 * ③ 名里有字没换（逐字比，见上）。返回具体条目，好在重试时点名批评。
 */
export function findIdentityViolations (a: RenameAnalysis): string[] {
  const out: string[] = []
  for (const c of a.characters) {
    if (c.replacement === c.original) {
      out.push(`${c.original} 原样没换`)
      continue
    }
    const stuck = unchangedGivenChars(c.original, c.replacement)
    if (stuck.length > 0) {
      out.push(`${c.original} → ${c.replacement}（"${stuck.join('""')}"没换）`)
    }
    for (const p of c.pairs) {
      if (p.to === p.from) out.push(`${p.from} 原样没换`)
    }
  }
  return out
}

export function hasIdentityViolation (a: RenameAnalysis): boolean {
  return findIdentityViolations(a).length > 0
}

/** 纠正语：把上一轮的具体违规点名列出来，比泛泛地说"要全换"有效得多。 */
function retryNudge (violations: string[]): string {
  return '\n\n【纠正】上一次这些名字没有改干净：\n' +
    violations.map((v) => `  · ${v}`).join('\n') +
    '\n这一次务必做到：姓保留，姓之后【每一个字】都换成读音相同的另一个字（谐音字）。' +
    '同一位置绝不能出现和原字相同的字。配角也一样，不许偷懒。'
}

async function callDeepSeek (novel: string, extraSystem: string, deps: AnalyzeDeps): Promise<RenameAnalysis> {
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
          { role: 'system', content: SYSTEM_PROMPT + extraSystem },
          { role: 'user', content: buildUserPrompt(novel) },
        ],
        temperature: 0.4,
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

/**
 * API-2 的系统提示词：**复查**。
 *
 * 第一次调用负责"分析 + 出映射"，难免有漏——尤其【孤立的数字行】（光秃秃一个
 * "17" 就是章节号）这种，没有任何字符特征可循，只有语义能判。所以第二次调用
 * 拿【第一层处理完的文本】再过一遍，专门捞漏网的非正文内容，并顺手核对改名
 * 是否留了尾巴。同样【只出指令】，删除仍由代码执行。
 */
export const REVIEW_SYSTEM_PROMPT = `你是中文小说正文的清理复查器。给你的文本已经过一轮清理（去章节标题、人名改谐音）。
你的任务是【复查还有什么不该出现在视频里的内容漏掉了】，只输出一个 JSON 对象，不要解释、不要 markdown。

重点找这些漏网的"非正文"：
  · 【孤立的数字行】：整行只有一个数字（如 "17"、"023"）——那是章节号，必须删。
  · 残留的章节/卷标记：第十七章、卷二、Chapter 5、（三）、十七
  · 作者的话、求收藏/求月票、更新说明、字数统计
  · 分隔线与装饰：——————、***、===、···
  · 站点水印/来源/广告：本文首发、请记住本站、XX小说网、免费阅读
  · 明显不是故事内容的杂项（页码、时间戳、书签标记等）

输出：
{"removeLines":["要整行删除或从行首删掉的原文串，原样、完整"],
 "leftoverNames":["文本里仍然出现的、看起来像未改名的原人名（可选，用于提醒）"]}

⚠️ 铁律：
  · removeLines 里的每一项都必须是文本里【原样出现过】的串，否则无效。
  · 只挑"非正文"。剧情内容里出现的数字（"他等了3年"）绝不能删。
  · 宁可漏挑，也绝不误删正文。没有要删的就给空数组。`

export interface ReviewResult { removeLines: string[]; leftoverNames: string[] }

/** 收敛复查结果，防 LLM 乱给字段 */
export function coerceReview (raw: unknown): ReviewResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : []
  return { removeLines: arr(o.removeLines), leftoverNames: arr(o.leftoverNames) }
}

/**
 * API-2：复查第一层的清理结果，捞漏网的非正文内容。
 * **失败不阻塞**——调用方拿不到结果就沿用第一层的产物即可。
 */
export async function reviewCleanup (text: string, deps: AnalyzeDeps = {}): Promise<ReviewResult> {
  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，无法做清理复查')
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
          { role: 'system', content: REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: `复查下面这段已清理过的正文，只输出 JSON：\n\n${text}` },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`清理复查失败（DeepSeek ${res.status}）`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('DeepSeek 返回为空')
    return coerceReview(extractJson(content))
  } finally {
    clearTimeout(timer)
  }
}

export async function analyzeNovel (novel: string, deps: AnalyzeDeps = {}): Promise<RenameAnalysis> {
  const first = await callDeepSeek(novel, '', deps)
  /*
   * 模型常见两种偷懒：整名原样返回、或只换一个字（沈砚之→沈砚知，中间那个
   * "砚"没动）。两种都算违规，带上【具体哪几个字没换】重试一次——点名比
   * 泛泛要求有效得多。二次仍有个别改不动的，前端替换表可手工兜底。
   */
  const v1 = findIdentityViolations(first)
  if (v1.length === 0) return first
  const second = await callDeepSeek(novel, retryNudge(v1), deps)
  // 二次更差就退回一次（比较"没换干净"的条目数，取少的）
  return findIdentityViolations(second).length <= v1.length ? second : first
}
