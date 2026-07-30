import { extractJson, type AnalyzeDeps } from '../rename/deepseek.js'

/**
 * 让 AI 按故事的类型和情绪挑一首背景音乐。
 *
 * ── 为什么值得单独调一次 ────────────────────────────────────────────
 * 素材库里九首曲子的文件名本身就是标签：「若梦 古言 虐文」「大女主 爽文」
 * 「一笑倾城 现言 甜文」……匹配它们要读懂故事是古装还是现代、是爽是虐。
 * 这是语义判断；按文件名字典序取第一首（现在的默认）等于每条片子都配
 * 同一首曲子，营销号最忌讳这个。
 *
 * ── 只在用户【没选过】的时候写 ──────────────────────────────────────
 * 推荐是默认值，不是命令。用户一旦自己挑过（bgmLibraryId 非空），
 * 后面任何一次分析都不许再动它——否则他改完过一会儿又被"智能"改回去，
 * 而他根本不知道是谁改的。
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

/** 发给模型的候选：只要 id 和文件名，文件名里的标签就是全部依据 */
export interface BgmChoice { id: string; filename: string }

export const BGM_SYSTEM_PROMPT = `你是短视频的配乐编辑。给你一段故事的开头和一份背景音乐清单，
挑出最搭的一首。

清单里每首曲子的文件名带着标签，含义：
- 古言 = 古装背景；现言 = 现代背景
- 甜文 = 轻松甜蜜；虐文/虐心 = 压抑悲伤；爽文/大女主 = 打脸逆袭、节奏强
- 通用 = 什么都能配，但只在实在挑不出更贴切的时候才选它

判断顺序：先看朝代背景（古装还是现代），再看情绪基调（甜、虐、爽）。
背景对不上的一律排除——古装故事配现代情歌是最刺耳的错误。

只输出 JSON，不要解释：
{"id": "选中那首的 id", "reason": "20 字以内说明为什么"}`

export interface BgmPick { id: string; reason: string }

export function coerceBgmPick (raw: unknown, choices: BgmChoice[]): BgmPick | null {
  const r = (raw ?? {}) as { id?: unknown; reason?: unknown }
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  /*
   * 【id 必须在清单里】。模型偶尔会把文件名当 id 回、或者自己编一个。
   * 不校验的话会写进 bgmLibraryId，然后合成时找不到这首曲子——
   * 表现是"成片没有背景音乐"，而没人会想到是配乐推荐写坏了一个 id。
   */
  const hit = choices.find((c) => c.id === id)
  if (!hit) return null
  const reason = typeof r.reason === 'string' && r.reason.trim() !== ''
    ? r.reason.trim().slice(0, 30)
    : '按故事类型匹配'
  return { id: hit.id, reason }
}

export async function recommendBgm (
  text: string, choices: BgmChoice[], deps: AnalyzeDeps = {},
): Promise<BgmPick | null> {
  if (choices.length === 0) return null
  const apiKey = deps.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，无法推荐配乐')
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 60_000)

  // 开头 800 字足够定朝代和基调，发全文只是浪费
  const head = text.trim().slice(0, 800)
  const list = choices.map((c) => `${c.id}  ${c.filename}`).join('\n')

  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: BGM_SYSTEM_PROMPT },
          { role: 'user', content: `=== 故事开头 ===\n${head}\n\n=== 可选曲目 ===\n${list}` },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`配乐推荐失败（DeepSeek ${res.status}）`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('DeepSeek 返回为空')
    return coerceBgmPick(extractJson(content), choices)
  } finally {
    clearTimeout(timer)
  }
}
