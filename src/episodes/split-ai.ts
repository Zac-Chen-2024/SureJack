import { splitSentences, totalEstimatedMs, type Sentence } from './sentences.js'
import { extractJson, type AnalyzeDeps } from '../rename/deepseek.js'

/**
 * 让 AI 挑「主片切在哪儿」和「引子到哪儿为止」。
 *
 * ── 为什么这件事非 AI 不可 ──────────────────────────────────────────
 * 按字数机械切会切在一句废话中间，观众不会追第二集。要的是**悬念点**：
 * 一个刚抛出问题、还没给答案的位置。那是语义判断，规则写不出来。
 *
 * ── 但时长【不听 AI 的】────────────────────────────────────────────
 * 模型很爱顺口报一个"大约八分钟"，那是编的。这里的做法是：
 *   AI 只回【句子编号】，时长一律由本地按字数估（estimateAudioMs）。
 * 于是"这个候选切下去多长"这件事永远有一个可复算、可解释的来源，
 * 而不是模型的一句话。
 *
 * ── 给多个候选，不替用户拍板 ────────────────────────────────────────
 * 悬念这事没有唯一解，7 分钟和 10 分钟各有各的道理。所以要 3 个候选，
 * 每个带上"为什么这里算悬念"，让用户滚过去看一眼再定。
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

/** 主片目标时长区间。7–10 分钟是营销号长文最常见的单集长度 */
export const TARGET_MIN_MS = 7 * 60 * 1000
export const TARGET_MAX_MS = 10 * 60 * 1000

/**
 * 引子最长多久。**按时长卡，不按句数**。
 *
 * 第一次实跑 AI 划了 36 句 = 1 分 30 秒的回顾，续集开头一分半都在复述
 * 第一集——追更的人会直接划走。40 秒差不多是"讲清楚是谁、发生了什么"
 * 的下限，再长就是在替观众重看一遍。
 *
 * 【句数不是好指标】：同样 20 句，对话体可能只有 15 秒，铺陈体能到 2 分钟。
 */
export const MAX_INTRO_MS = 40 * 1000

export interface BreakCandidate {
  /** 切在这一句【之后】 */
  sentenceIndex: number
  /** 为什么这里是悬念点。给用户看，帮他判断 */
  reason: string
  /** 切到这里主片有多长（本地按字数估的，不是模型说的） */
  estimatedMs: number
}

export interface SplitPlan {
  /** 引子到这一句【结束】为止（续集开头重念的那部分） */
  introEndIndex: number
  /** 断点候选，按句子顺序排 */
  candidates: BreakCandidate[]
  /** 全文切好的句子。前端滚轮直接用它，保证编号和后端一致 */
  sentences: Sentence[]
}

export const SPLIT_SYSTEM_PROMPT = `你是中文长篇故事的分集编辑，服务于"营销号短视频"的拆集需求。

给你一段已编号的正文（每行形如「[12] 句子内容」）。你要做两件事：

【一】选出 3 个「主片断点」候选。
- 断点是主片的最后一句，续集从下一句接着讲。
- 只能从我给出的【可选范围】里挑，那个范围是按配音时长算出来的，范围外的一律不要。
- 好的断点是**悬念点**：刚抛出一个问题、刚出现一个转折、刚有人说了半句要紧的话，
  而答案还没揭晓。观众看到这里会想"然后呢"。
- 坏的断点：一段平铺直叙的中间、一个已经收尾的场景之后、纯环境描写处。
- 三个候选要**分散开**，不要挤在相邻几句里，让用户有得选。
- 每个候选写一句话说明"为什么这里断"，20 字以内，说人话，不要写"此处为高潮"这种空话。

【二】选出「引子」的结束句。
- 引子是续集开头要重念一遍的部分，作用是让没看过第一集的人也能听懂后面。
- **越短越好**：交代清楚主角是谁、处境是什么就够了，观众是来看后续的，
  不是来重看第一集的。
- 我在【引子上限】里给了一个句号，你选的编号**不能超过它**。
- 通常就是开篇那几句钩子，到"故事正式开始"为止。

只输出 JSON，不要任何解释文字：
{
  "candidates": [
    {"sentenceIndex": 数字, "reason": "为什么这里断"},
    {"sentenceIndex": 数字, "reason": "..."},
    {"sentenceIndex": 数字, "reason": "..."}
  ],
  "introEndIndex": 数字
}`

interface RawPlan {
  candidates?: { sentenceIndex?: unknown; reason?: unknown }[]
  introEndIndex?: unknown
}

/**
 * 引子最多能到第几句：累计朗读时长不超过 MAX_INTRO_MS。
 * 第一句就超了也至少给一句——一句话的引子总好过没有引子。
 */
export function maxIntroIndex (sentences: Sentence[]): number {
  let last = 0
  for (const s of sentences) {
    if (s.cumulativeMs > MAX_INTRO_MS) break
    last = s.index
  }
  return Math.min(last, Math.max(0, sentences.length - 1))
}

/**
 * 把模型的回答收拢成能用的东西。
 *
 * 【全部下标都要夹到合法范围】。模型偶尔会报一个越界的句号（比如全文只有
 * 400 句却回了 512）。不夹的话，切分时会切出一个空的续集——而这在界面上
 * 表现为"续集是空白项目"，没人会想到是模型多报了一个数。
 */
export function coerceSplitPlan (
  raw: unknown, sentences: Sentence[], allowed: { min: number; max: number },
): { introEndIndex: number; candidates: { sentenceIndex: number; reason: string }[] } {
  const r = (raw ?? {}) as RawPlan
  const last = sentences.length - 1
  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

  const seen = new Set<number>()
  const candidates: { sentenceIndex: number; reason: string }[] = []
  for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
    const n = Number(c?.sentenceIndex)
    if (!Number.isFinite(n)) continue
    const idx = clamp(Math.trunc(n), allowed.min, allowed.max)
    if (seen.has(idx)) continue
    seen.add(idx)
    const reason = typeof c?.reason === 'string' && c.reason.trim() !== ''
      ? c.reason.trim().slice(0, 40)
      : '模型没说明理由'
    candidates.push({ sentenceIndex: idx, reason })
  }

  /*
   * 【引子按时长夹，不按句数】。模型上一版被要求"10–30 句"，它回了 36 句
   * = 1 分半的回顾。改成硬卡 40 秒：提示词里也把上限告诉它，但最终以
   * 这里的夹取为准——提示词是建议，代码才是保证。
   */
  const introCap = maxIntroIndex(sentences)
  const introRaw = Number(r.introEndIndex)
  const introEndIndex = Number.isFinite(introRaw)
    ? clamp(Math.trunc(introRaw), 0, introCap)
    : introCap

  candidates.sort((a, b) => a.sentenceIndex - b.sentenceIndex)
  return { introEndIndex, candidates }
}

/**
 * 算出「切到第几句为止」的合法范围：主片估算时长落在 7–10 分钟之间。
 *
 * 【范围为空时要退让而不是报错】。全文本来就不到 7 分钟的话，硬求这个区间
 * 会得到一个空集合，接口只能报错——可用户明明只是写了一篇短文。这时候
 * 退成"全文的中段"，让他仍然能拆，只是两集都短一点。
 */
export function allowedRange (sentences: Sentence[]): { min: number; max: number } {
  const inRange = sentences.filter(
    (s) => s.cumulativeMs >= TARGET_MIN_MS && s.cumulativeMs <= TARGET_MAX_MS)
  if (inRange.length > 0) {
    return { min: inRange[0]!.index, max: inRange[inRange.length - 1]!.index }
  }
  const last = sentences.length - 1
  const total = totalEstimatedMs(sentences)
  if (total < TARGET_MIN_MS) {
    // 全文比一集还短：允许在中间偏后的范围里挑，两集都短但仍然成立
    return { min: Math.floor(last * 0.4), max: Math.max(0, last - 1) }
  }
  // 全文远超 10 分钟且没有句子正好落在区间里（句子特别长时会这样）
  const firstOver = sentences.find((s) => s.cumulativeMs > TARGET_MAX_MS)
  const i = firstOver ? firstOver.index : last
  return { min: Math.max(0, i - 1), max: Math.max(0, i) }
}

export async function planSplit (text: string, deps: AnalyzeDeps = {}): Promise<SplitPlan> {
  const sentences = splitSentences(text)
  if (sentences.length < 4) {
    throw new Error('正文太短，拆不出主片和续集（不足 4 句）')
  }
  const allowed = allowedRange(sentences)

  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，无法分析断点')
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 120_000)

  /*
   * 【只把可能用到的句子发过去】。全文可能上万字，而断点只会落在中段，
   * 引子只会落在开头——发全文既慢又贵，还让模型更容易在无关段落上跑偏。
   * 发的是：开头 40 句（够它划引子）+ 可选范围前后各 20 句（够它找悬念）。
   */
  const head = sentences.slice(0, 40)
  const mid = sentences.slice(Math.max(0, allowed.min - 20), Math.min(sentences.length, allowed.max + 20))
  const numbered = (arr: Sentence[]): string =>
    arr.map((s) => `[${s.index}] ${s.text.trim()}`).join('\n')
  const user = [
    `全文共 ${sentences.length} 句，总估算配音时长 ${Math.round(totalEstimatedMs(sentences) / 60000)} 分钟。`,
    `断点【可选范围】：第 ${allowed.min} 句 到 第 ${allowed.max} 句（含两端）。范围外的编号一律无效。`,
    `引子【上限】：最多到第 ${maxIntroIndex(sentences)} 句（再往后念就超过 40 秒了）。`,
    '',
    '=== 开头部分（用来划引子）===',
    numbered(head),
    '',
    '=== 可选范围附近（用来找悬念点）===',
    numbered(mid),
  ].join('\n')

  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SPLIT_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`断点分析失败（DeepSeek ${res.status}）`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('DeepSeek 返回为空')
    const { introEndIndex, candidates } = coerceSplitPlan(extractJson(content), sentences, allowed)

    /*
     * 一个候选都没解析出来时【兜一个中点】而不是报错。模型偶尔会回一个
     * 格式怪异的 JSON，但用户这边只是想拆个片子——给他一个能用的默认值、
     * 让他自己滚轮调整，比让他对着"分析失败"重试要好。
     */
    const list = candidates.length > 0
      ? candidates
      : [{ sentenceIndex: Math.floor((allowed.min + allowed.max) / 2), reason: '按时长取的中点' }]

    return {
      introEndIndex,
      sentences,
      candidates: list.map((c) => ({
        ...c,
        // 时长一律本地算，绝不用模型报的数
        estimatedMs: sentences[c.sentenceIndex]?.cumulativeMs ?? 0,
      })),
    }
  } finally {
    clearTimeout(timer)
  }
}
