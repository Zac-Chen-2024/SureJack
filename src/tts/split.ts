import { estimateAudioMs, maxCharsForMs } from './azure.js'

/**
 * 每段的目标上限。Azure 单次硬上限是 10 分钟，这里取 8 分钟：
 * estimateAudioMs 有 ±5% 波动，留 2 分钟余量避免估算偏低时打到 Azure 才失败。
 */
const DEFAULT_MAX_MS = 8 * 60 * 1000

/** 句末标点。逗号【不在】此列——在逗号处切，接缝的语气断裂会很明显。 */
const SENTENCE_END = /[。！？；…\n]/

/**
 * 把文案切成若干段，每段估算时长不超过 maxMs。
 *
 * 只在句末标点【之后】切。切点选在自然停顿处，独立合成时
 * 段与段之间的语气变化才会被听成「一次停顿」而非「一处断裂」。
 *
 * 短文案原样返回单元素数组——调用方据此跳过拼接路径，
 * 行为与未引入分段前完全一致。
 */
export function splitScript (text: string, maxMs = DEFAULT_MAX_MS): string[] {
  if (estimateAudioMs(text.length) <= maxMs) return [text]

  // 先按句末标点切成句子，标点跟在句子末尾
  const sentences: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (SENTENCE_END.test(ch)) { sentences.push(cur); cur = '' }
  }
  if (cur) sentences.push(cur)   // 结尾没标点的残句

  const maxChars = maxCharsForMs(maxMs)
  const chunks: string[] = []
  let buf = ''

  for (const s of sentences) {
    // 单句本身就超预算：先冲掉缓冲，再把这句硬切。
    // 没有这一步会死循环——它永远塞不进任何缓冲区。
    if (s.length > maxChars) {
      if (buf) { chunks.push(buf); buf = '' }
      for (let i = 0; i < s.length; i += maxChars) {
        chunks.push(s.slice(i, i + maxChars))
      }
      continue
    }
    // 先判断再累加。反过来「先加后判」会放出超预算的段。
    if (buf.length + s.length > maxChars) { chunks.push(buf); buf = '' }
    buf += s
  }
  if (buf) chunks.push(buf)

  return chunks
}
