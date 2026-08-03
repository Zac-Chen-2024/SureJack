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

/** 一行字幕的字数（标点也算，只用来判断"要不要送去语义切"） */
function lineChars (line: SubtitleLine): number {
  return line.words.reduce((n, w) => n + [...w.text].length, 0)
}

/**
 * 挑出【机械切完仍然超限】的行。它们就是"一整段没有标点可断"的长句——
 * 有标点的早被断干净了，只有这些是被硬断出来的。
 *
 * 送去做语义切分的就是这些，不是全文的每一句：一篇 6000 字里这种行
 * 通常只有十几条，而句子有几百句。
 */
export function overlongLines (lines: SubtitleLine[], maxChars: number): number[] {
  return lines.flatMap((l, i) => (lineChars(l) > maxChars ? [i] : []))
}

/** 一行的纯文本（拼接词，标点照留）——发给模型看的就是它 */
export function lineText (line: SubtitleLine): string {
  return line.words.map((w) => w.text).join('')
}

/**
 * 按【字符下标断点】把一行切成几行。
 *
 * ⚠️【断点吸附到词边界】。时间轴是从词级时间戳推出来的，切在一个词中间
 * 就没有时间可用了。模型看到的是纯文本、并不知道 Azure 把哪几个字算一个词，
 * 所以吸附这一步必须在这儿做：落到离它最近的那个词缝上。
 *
 * 吸附之后如果两个断点落到了同一条缝、或者落在首尾（切出空行），
 * 就把这个断点丢掉——宁可这一行长一点，也不能产出一条空字幕。
 */
export function applyCuts (line: SubtitleLine, points: readonly number[]): SubtitleLine[] {
  // 每个词【结束】时的累计字数 = 一条可用的缝
  const seams: number[] = []
  let acc = 0
  for (const w of line.words) {
    acc += [...w.text].length
    seams.push(acc)
  }
  const total = acc

  const snapped = new Set<number>()
  for (const p of points) {
    if (p <= 0 || p >= total) continue
    /*
     * 【正中间时取靠后那条】。模型给的下标是"第一段有几个字"，它看不见
     * 词边界；落在正中间说明它想把那个词整个留在前一段，往后靠正好如它所愿。
     * 规则本身不重要，重要的是【确定】——不定的话同一个断点两次运行
     * 可能切出不同的字幕。
     */
    let best = seams[0]!
    for (const s of seams) {
      if (Math.abs(s - p) <= Math.abs(best - p)) best = s
    }
    if (best > 0 && best < total) snapped.add(best)
  }
  if (snapped.size === 0) return [line]

  const cuts = [...snapped].sort((a, b) => a - b)
  const out: SubtitleLine[] = []
  let bucket: WordTiming[] = []
  let seen = 0
  let next = 0
  const flushBucket = (): void => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    out.push({
      startMs: first.offsetMs,
      endMs: last.offsetMs + last.durationMs,
      words: bucket,
    })
    bucket = []
  }
  for (const w of line.words) {
    bucket.push(w)
    seen += [...w.text].length
    if (next < cuts.length && seen === cuts[next]) {
      flushBucket()
      next += 1
    }
  }
  flushBucket()
  return out
}
