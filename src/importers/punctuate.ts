/**
 * 标点体检 + 补标点。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 这条流水线上【断句全靠原文自带的标点】：Azure 会为标点单独触发事件，
 * 字幕按标点断行，分集按标点切句。实测一篇正常网文 5790 字里有 601 个
 * 标点——平均每 10 字一个，621 行字幕里只有 3 行需要额外处理。
 *
 * 但有些抓取源是整段流水账，几百字不见一个句号。那种文本进来之后：
 *   · 配音会一口气念到底，没有停顿
 *   · 字幕每一行都超限，只能靠字数硬断，成语词组全被劈开
 *   · 分集的"按句子滚"退化成"按 100 字滚"
 * 所以要在【配音之前】把标点补上——补完 Azure 才会在那儿停顿。
 *
 * ── ⚠️ 只加标点，不改一个字 ────────────────────────────────────────
 * 和字幕语义切分同一条纪律：把结果里的标点全去掉，必须和原文去掉标点
 * 之后逐字相同，否则整篇丢弃、当作没补过。模型很容易顺手"润色"一下，
 * 而这条流水线上的文案是用户的作品，不是模型的草稿。
 *
 * ── 正常的不动 ──────────────────────────────────────────────────────
 * 体检通过就一次 API 都不调。绝大多数文本本来就是好的，为它们花钱、
 * 花时间、还冒被改写的风险，完全不划算。
 */

/** 中文正文里算作断句的标点 */
const BREAKERS = /[。！？；，、：…—\n]/g

/**
 * 【多少字一个标点算正常】。
 *
 * 实测正常网文约 10 字一个。取 25 作为分界线——正常文本离它很远，
 * 而"整段没标点"的文本会远远超过它。定得太严会把文风紧凑（大量短句
 * 但少用逗号）的正常文本误判成坏文本，白花一次调用还冒改写风险。
 */
export const PUNCT_CHARS_PER_MARK = 25

export interface PunctuationHealth {
  /** 正文字数（不含标点和空白） */
  chars: number
  marks: number
  /** 多少字一个标点。没有标点时是 Infinity */
  density: number
  healthy: boolean
}

export function checkPunctuation (text: string): PunctuationHealth {
  const marks = (text.match(BREAKERS) ?? []).length
  const chars = text.replace(BREAKERS, '').replace(/\s/g, '').length
  const density = marks === 0 ? Number.POSITIVE_INFINITY : chars / marks
  /*
   * 【太短的文本一律算健康】。一句话的测试文案本来就可能一个标点都没有，
   * 为它调一次 API 毫无意义，还会让所有短文案的新建流程凭空多等几秒。
   */
  if (chars < 200) return { chars, marks, density, healthy: true }
  return { chars, marks, density, healthy: density <= PUNCT_CHARS_PER_MARK }
}

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
const TIMEOUT_MS = 120_000

export const PUNCTUATE_SYSTEM_PROMPT = `你是中文小说正文的标点修复器。

给你一段几乎没有标点的正文，你要把标点补上，让它能正常断句朗读。

【绝对规则】
1. 只能【增加】标点符号（。！？；，、：）和换行。
2. 一个汉字都不能增、删、改、调换顺序。
3. 把你的结果里的标点和换行全部去掉之后，必须和原文去掉标点之后逐字相同。
4. 不要润色、不要改写、不要加"他说"这类补充，哪怕你觉得读起来更顺。

只回 JSON：{"text":"补好标点的正文"}`

export interface PunctuateDeps {
  apiKey?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/** 去掉标点和空白，用来做"逐字相同"的比对 */
export function bareText (s: string): string {
  return s.replace(BREAKERS, '').replace(/[\s"'“”‘’（）()《》【】]/g, '')
}

/**
 * 给一段文本补标点。
 *
 * @returns 补好的文本；体检通过、或者模型改了字、或者调用失败，都返回 null
 *          （调用方原样用旧文本，不当成错误）
 */
export async function punctuate (
  text: string, deps: PunctuateDeps = {},
): Promise<string | null> {
  if (checkPunctuation(text).healthy) return null

  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) return null
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: PUNCTUATE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (content === undefined || content === '') return null
    const obj = JSON.parse(content) as { text?: unknown }
    const out = typeof obj.text === 'string' ? obj.text : null
    if (out === null) return null
    // ⚠️ 逐字校验：改了一个字就整篇作废
    if (bareText(out) !== bareText(text)) return null
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
