import { estimateAudioMs, maxCharsForMs } from './azure.js'

/**
 * 每段的目标上限。Azure 单次硬上限是 10 分钟，这里取 8 分钟：
 * estimateAudioMs 有 ±5% 波动，留 2 分钟余量避免估算偏低时打到 Azure 才失败。
 */
const DEFAULT_MAX_MS = 8 * 60 * 1000

/**
 * 可以下刀的位置。**逗号在此列**。
 *
 * ⚠️【原来不认逗号，代价是拦腰砍断一个词】。这条流水线上的文案没有句号
 * （作者一行一句、行尾一个逗号），而送 Azure 之前 normalizeScript 会把
 * 换行压成空格——于是一篇 8028 字的文案在这里【一个可切点都找不到】，
 * 掉进下面"单句超预算"的分支按字数硬切。实测接缝落在：
 *     …他教我仙术，教我为人，朝夕相 | 处…
 * 把"朝夕相处"劈成两半。而线上已经有一条片子是这么配出来的。
 *
 * 在逗号处切确实比在句号处切生硬一点，但那是【和句号比】。
 * 没有句号可比的时候，逗号是自然停顿，硬切是砍在词中间——差得远。
 */
const SENTENCE_END = /[，,。！!？?；;…\n]/

/**
 * 把文案切成若干段，每段估算时长不超过 maxMs。
 *
 * 只在标点【之后】切。切点选在自然停顿处，独立合成时
 * 段与段之间的语气变化才会被听成「一次停顿」而非「一处断裂」。
 * 一个标点都找不到时才按字数硬切——那是最后的兜底，不是常态。
 *
 * 短文案原样返回单元素数组——调用方据此跳过拼接路径，
 * 行为与未引入分段前完全一致。
 */
export function splitScript (text: string, maxMs = DEFAULT_MAX_MS, rate = 0): string[] {
  // rate 是语速百分比偏移：调慢会让实际音频变长，估算必须跟着放大，
  // 否则某段真到 Azure 才发现超 10 分钟上限。见 azure.ts 的 rateFactor。
  if (estimateAudioMs(text.length, rate) <= maxMs) return [text]

  // 先按句末标点切成句子，标点跟在句子末尾
  const sentences: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (SENTENCE_END.test(ch)) { sentences.push(cur); cur = '' }
  }
  if (cur) sentences.push(cur)   // 结尾没标点的残句

  const maxChars = maxCharsForMs(maxMs, rate)
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
