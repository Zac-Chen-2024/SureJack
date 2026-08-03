/**
 * 长句的【语义切分】：一条字幕超过上限时，交给 LLM 按语义切成几段先后显示。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 现在的切法是机械的：标点断句 + 字数兜底。超限时在第 N 个字处硬断，
 * 经常把成语、词组、"不+动词"劈成两半，读起来磕磕绊绊。
 *
 * ── ⚠️ 唯一的硬约束：一个字都不能改 ────────────────────────────────
 * 配音是照着原文案念的，字幕的时间轴是从 Azure 的【词级时间戳】推出来的。
 * 模型只要动了一个字，字幕就和耳朵里听到的对不上、时间轴也接不回去。
 * 所以这里只收【断点】，并且：
 *   1. 把切回来的几段拼起来，必须和原句【逐字相同】（去空白后比较），
 *      不同就整句丢弃，回退到机械切法；
 *   2. 断点【吸附到词边界】由调用方做（见 segment.ts）——模型看到的是
 *      纯文本，它不知道 Azure 把哪几个字当成一个词。
 *
 * ── 两层 ────────────────────────────────────────────────────────────
 * 第一层切，第二层复查（成语被劈开？否定词和动词分家？某段只剩两个字？）。
 * 和人名替换那条链同一个套路：一次生成 + 一次复查，各自可以单独失败。
 * 第二层没过退回第一层，第一层没过退回机械切法——"AI 没答上来"绝不能
 * 变成"字幕烧不出来"。
 */

/** 一条字幕最多几个字。超过就送去切 */
export const SUBTITLE_CUT_MAX = 19

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
/** 和人名分析同一个理由：DeepSeek 的延迟波动很大，60 秒卡在波动上沿 */
const TIMEOUT_MS = 120_000

export interface CutDeps {
  apiKey?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const CUT_SYSTEM_PROMPT = `你是中文短视频字幕的断句器。

给你若干条过长的字幕，每条前面有编号。你要为每条给出【断开位置】，
让它变成两段或多段，每段不超过 ${SUBTITLE_CUT_MAX} 个字。

【绝对规则】
1. 一个字都不能增、删、改。你只是在原文里插入分隔符 |。
2. 把你的结果去掉 | 之后，必须和原文逐字相同。
3. 在语义完整的地方断：主谓之间、动宾之间、分句之间、"的/地/得"之后都可以；
   成语、人名、数量词、"不/没+动词"这类绝不能劈开。
4. 每一段单独看都要成话，不要切出"他"、"的时候"这种碎片。
5. 段数取最少：能切两段就不要切三段。

只回 JSON：{"cuts":[{"i":编号,"text":"带 | 的原文"}]}`

export const REVIEW_SYSTEM_PROMPT = `你是中文字幕断句的复查器。

给你若干条已经断好的字幕（| 是断点），逐条判断断得对不对：
- 有没有把成语、人名、数量词、"不/没+动词"劈成两半
- 有没有哪一段单独看不成话（"他"、"的时候"这种碎片）
- 有没有哪一段还超过 ${SUBTITLE_CUT_MAX} 个字

有问题的重新给一版；没问题的不要出现在结果里。

【绝对规则】和上一步一样：一个字都不能增删改，去掉 | 必须和原文逐字相同。

只回 JSON：{"fixed":[{"i":编号,"text":"带 | 的原文"}]}`

/** 去掉所有空白和分隔符，用来做"逐字相同"的比对 */
function bare (s: string): string {
  return s.replace(/[\s|]/g, '')
}

/**
 * 校验并解析一条切分结果。
 * 返回每一段的【字符下标断点】（相对原句），不合法返回 null。
 */
export function cutPointsOf (original: string, marked: string): number[] | null {
  if (bare(marked) !== bare(original)) return null      // 动了字，整条作废
  const parts = marked.split('|').map((p) => p.replace(/\s/g, ''))
  if (parts.length < 2 || parts.some((p) => p === '')) return null
  const points: number[] = []
  let acc = 0
  for (const p of parts.slice(0, -1)) {
    acc += [...p].length
    points.push(acc)
  }
  return points
}

interface RawCut { i?: unknown, text?: unknown }

function parseCuts (raw: unknown, key: 'cuts' | 'fixed'): Map<number, string> {
  const out = new Map<number, string>()
  const o = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(o[key]) ? o[key] as RawCut[] : []
  for (const c of list) {
    const i = Number(c?.i)
    if (!Number.isInteger(i) || typeof c?.text !== 'string') continue
    out.set(i, c.text)
  }
  return out
}

async function ask (
  system: string, user: string, deps: CutDeps,
): Promise<unknown> {
  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，无法做字幕语义切分')
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`字幕切分失败（DeepSeek ${res.status}）`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (content === undefined || content === '') throw new Error('DeepSeek 返回为空')
    return JSON.parse(content)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给一批长句算断点。
 *
 * @param sentences 过长的句子原文，顺序即编号
 * @returns 下标 → 断点数组。没切成的句子不出现在结果里（调用方回退机械切法）
 *
 * 【批量发，不逐句发】：一篇 6000 字里超过 19 字的句子可能上百句，
 * 逐句调用又慢又贵，还会撞限速。
 */
export async function planCuts (
  sentences: string[], deps: CutDeps = {},
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>()
  if (sentences.length === 0) return result

  const numbered = sentences.map((s, i) => `[${i}] ${s}`).join('\n')
  const first = parseCuts(await ask(CUT_SYSTEM_PROMPT, numbered, deps), 'cuts')

  /*
   * 第二层复查。只把【第一层切出来的】发过去——没切成的句子本来就要
   * 回退机械切法，让模型再看一遍没有意义，还多花钱。
   */
  const ok = new Map<number, string>()
  for (const [i, text] of first) {
    const src = sentences[i]
    if (src !== undefined && cutPointsOf(src, text) !== null) ok.set(i, text)
  }
  if (ok.size > 0) {
    try {
      const toReview = [...ok].map(([i, t]) => `[${i}] ${t}`).join('\n')
      const fixed = parseCuts(await ask(REVIEW_SYSTEM_PROMPT, toReview, deps), 'fixed')
      for (const [i, text] of fixed) {
        const src = sentences[i]
        // 复查给的版本同样要过逐字校验；不过就留着第一层的
        if (src !== undefined && cutPointsOf(src, text) !== null) ok.set(i, text)
      }
    } catch {
      // 复查失败不影响第一层的结果——它已经过了逐字校验
    }
  }

  for (const [i, text] of ok) {
    const pts = cutPointsOf(sentences[i]!, text)
    if (pts !== null) result.set(i, pts)
  }
  return result
}
