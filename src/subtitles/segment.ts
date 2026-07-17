import type { WordTiming, SubtitleLine } from '../types.js'

/**
 * 把词级时间戳切成字幕行。
 *
 * 规则（设计文档第 7 节）：
 *   - 标点是天然断句点——Azure 会为标点单独触发事件，我们不用碰中文分词
 *   - 字数上限兜底，避免竖屏放不下
 *   - 行的起止时间【完全由时间戳推导】，从不手动指定：
 *     时间永远是配音的函数，只有一个真相来源
 *
 * 这是纯函数：无 IO、无状态。结果是推导数据，不入库。
 */
export function segmentLines (words: WordTiming[], maxChars: number): SubtitleLine[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(`maxChars 必须是正数，收到 ${maxChars}`)
  }

  const lines: SubtitleLine[] = []
  let cur: WordTiming[] = []

  const curChars = (): number => cur.reduce((n, x) => n + [...x.text].length, 0)

  const flush = (): void => {
    if (cur.length === 0) return
    const first = cur[0]!
    const last = cur[cur.length - 1]!
    lines.push({
      startMs: first.offsetMs,
      endMs: last.offsetMs + last.durationMs,
      words: cur,
    })
    cur = []
  }

  for (const word of words) {
    if (word.isPunctuation) {
      // 连续标点：上一个标点刚断完行，cur 是空的。标点不能独占一行
      // （屏幕上会闪过一个孤零零的标点），把它附回上一行末尾，并把
      // 上一行的 endMs 延到这个标点的结束——时间戳依然完全由词时间推导。
      const prevLine = lines[lines.length - 1]
      if (cur.length === 0 && prevLine !== undefined) {
        prevLine.words.push(word)
        prevLine.endMs = word.offsetMs + word.durationMs
        continue
      }
      // 标点留在本行末尾，不参与 maxChars 判断——标点通常只占 1 字，
      // 宁可让行略微超限也要让标点跟着正文，这是排版常识。
      cur.push(word)
      flush()
      continue
    }

    // 先判断再 push：若加入本词会让当前行超限，且当前行已有内容，
    // 就先断行，避免词已经进了 cur 才检查导致最后一个词把行撑爆。
    //
    // 无法避免的边界：单个词本身就超过 maxChars（例如一个 5 字词配
    // maxChars=4）时，它只能独占一行并超限——这是有意为之，不是漏洞。
    const wordChars = [...word.text].length
    if (cur.length > 0 && curChars() + wordChars > maxChars) {
      flush()
    }
    cur.push(word)

    if (curChars() >= maxChars) flush()
  }

  flush()   // 末尾没有标点时也要收尾，否则丢最后一行
  return lines
}
