import type { WordTiming, SubtitleLine } from '../types.js'
import { stripPunctuation } from './ass.js'

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
export function segmentLines (
  words: WordTiming[],
  maxChars: number,
  /**
   * 段文本 → 段内的字符断点。有它就在这些位置断，不再等字数撞上限。
   * 断点会吸附到词边界（见 applyCuts 的说明）。
   */
  cuts?: Map<string, number[]>,
): SubtitleLine[] {
  /*
   * 有语义断点的段，先按断点切成几截，再各自走一遍机械切法兜底
   * （模型偶尔会留下一截仍然超限，兜底保证屏幕装得下）。
   */
  if (cuts !== undefined && cuts.size > 0) {
    const out: SubtitleLine[] = []
    let at = 0
    for (const run of overlongRuns(words, maxChars)) {
      const pts = cuts.get(run.text)
      if (pts === undefined) continue
      out.push(...segmentLines(words.slice(at, run.from), maxChars))
      const whole = segmentLines(words.slice(run.from, run.to), Number.MAX_SAFE_INTEGER)
      for (const piece of whole) {
        for (const cut of applyCuts(piece, pts)) {
          out.push(...segmentLines(cut.words, maxChars))
        }
      }
      at = run.to
    }
    out.push(...segmentLines(words.slice(at), maxChars))
    return out
  }
  return segmentCore(words, maxChars)
}

function segmentCore (words: WordTiming[], maxChars: number): SubtitleLine[] {
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

/**
 * 一行字幕【实际会显示】的字数。
 *
 * ⚠️【必须按渲染结果算，不能按原始词表算】。烧录时 hidePunctuation 会把
 * 所有标点字形去掉（见 ass.ts 的 stripPunctuation），屏幕上根本没有标点。
 * 按带标点的长度判超限，会把本来放得下的行送去切——线上真遇到：
 *   原始词表：「】 【人类和人鱼在一起不能孕育后代，」= 17 字
 *   屏幕上：  「人类和人鱼在一起不能孕育后代」    = 14 字
 * 那一行压根不该被切，白花一次 LLM 调用，还多断了一次。
 * 弹幕体（【】包起来）的小说里这种行成片成片地出现。
 */
function lineChars (line: SubtitleLine): number {
  return line.words.reduce(
    (n, w) => n + (w.isPunctuation ? 0 : [...stripPunctuation(w.text)].length), 0)
}

/**
 * 挑出【机械切完仍然超限】的行。
 *
 * ⚠️ 正常情况下这个集合是【空的】——机械切分本来就以 maxChars 为上限，
 * 切完不可能还超过它。留着它只为一种边界：单个词本身就超过上限
 * （Azure 偶尔会把一长串没有标点的字当成一个词）。
 *
 * 【真正要送去语义切分的不是它，是 overlongRuns】。见下面那段。
 */
export function overlongLines (lines: SubtitleLine[], maxChars: number): number[] {
  return lines.flatMap((l, i) => (lineChars(l) > maxChars ? [i] : []))
}

/** 一串词【实际会显示】的字数 */
function runChars (words: readonly WordTiming[]): number {
  return words.reduce(
    (n, w) => n + (w.isPunctuation ? 0 : [...stripPunctuation(w.text)].length), 0)
}

/**
 * 按标点把词流切成一个个【段】，挑出【机械切法必须硬断】的那些。
 *
 * ⚠️ 这才是语义切分该管的那批。绕了一圈才想明白：
 * 我原来判的是"切完还超不超限"，而机械切法以 maxChars 为上限，切完
 * 【永远不超限】——那个集合恒为空，整层 LLM 根本不会触发。
 *
 * 真正出问题的是这种：一段话连着二十几个字没有任何标点，机械切法只能
 * 在"第 17 个字"处下刀，那一刀落在哪儿纯看字数——「大力出奇迹」被劈成
 * 「大力出 / 奇迹」就是这么来的。这些行【切完正好不超限】，所以老判据
 * 看不见它们。
 *
 * @returns 每个要切的段：段文本 + 它在 words 里的下标区间
 */
export function overlongRuns (
  words: WordTiming[], maxChars: number,
): Array<{ text: string; from: number; to: number }> {
  const out: Array<{ text: string; from: number; to: number }> = []
  let from = 0
  const push = (to: number): void => {
    const run = words.slice(from, to)
    if (run.length > 0 && runChars(run) > maxChars) {
      out.push({ text: run.map((w) => w.text).join(''), from, to })
    }
    from = to
  }
  for (const [i, w] of words.entries()) {
    if (w.isPunctuation) push(i + 1)     // 标点归上一段，和 segmentLines 一致
  }
  push(words.length)
  return out
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
