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
  const lines: SubtitleLine[] = []
  let cur: WordTiming[] = []

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
    cur.push(word)

    // 标点断行：标点留在本行末尾
    if (word.isPunctuation) { flush(); continue }

    const chars = cur.reduce((n, x) => n + [...x.text].length, 0)
    if (chars >= maxChars) flush()
  }

  flush()   // 末尾没有标点时也要收尾，否则丢最后一行
  return lines
}
