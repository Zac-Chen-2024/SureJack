import { pinyin } from 'pinyin-pro'

/**
 * 同音字表：给"这个字没换掉"兜底。
 *
 * ── 为什么代码要管这件事 ────────────────────────────────────────────
 * 之前"每个字都必须换成同音字"这条完全交给模型：检查出没换 → 整篇重跑
 * 最多两次 → 保留"最好的那一份"。而"最好的"仍可能带着一个没换的字，
 * 于是原名有一半还留在成片里。
 *
 * 实测（spikes/rename/）看清了三件事：
 *   · 单独重试一个名字 1.2 秒，整篇重跑 12 秒——而且重跑会把用户已经
 *     看顺眼的其它名字一起洗掉。
 *   · 模型经常【想不起来】有哪些同音字（"知"那次它没想到"之"）。
 *     查同音字是确定性的查表活，本来就不该问它。
 *   · 模型说的和做的会不一致：有一次它明说"崈是异体字不符合要求，故保留
 *     原字"，然后仍然返回了带"崈"的名字。所以【必须代码验收】。
 *
 * ── 异体字、生僻字都算数 ────────────────────────────────────────────
 * 用户明确说了：只要同音就行，字形常不常见无所谓。这一条让方案从
 * "大概能行"变成"几乎一定能行"——20902 个汉字里只有 56 个（0.27%）
 * 连一个同音字都没有。
 */

/** 只在这个区间里找候选：基本汉字区。够用，且不会掉进罕见的扩展区 */
const FIRST = 0x4e00
const LAST = 0x9fa5

let toneTable: Map<string, string[]> | null = null
let baseTable: Map<string, string[]> | null = null

/**
 * 建表。**懒加载**：两万次 pinyin 调用约几百毫秒，只有真需要兜底时才付。
 * 绝大多数项目一次都不会调到这里。
 */
function build (): void {
  if (toneTable !== null) return
  const tone = new Map<string, string[]>()
  const base = new Map<string, string[]>()
  for (let c = FIRST; c <= LAST; c++) {
    const ch = String.fromCodePoint(c)
    const t = pinyin(ch, { toneType: 'num', type: 'array' })[0] ?? ''
    const b = pinyin(ch, { toneType: 'none', type: 'array' })[0] ?? ''
    if (t !== '') {
      const arr = tone.get(t)
      if (arr === undefined) tone.set(t, [ch]); else arr.push(ch)
    }
    if (b !== '') {
      const arr = base.get(b)
      if (arr === undefined) base.set(b, [ch]); else arr.push(ch)
    }
  }
  toneTable = tone
  baseTable = base
}

export interface Homophones {
  /** 声调也一样的。优先用这批 */
  sameTone: string[]
  /** 声母韵母一样、声调不同的。同调里挑不出来时才用 */
  sameSound: string[]
}

/** 一个字的同音字候选（不含它自己） */
export function homophonesOf (ch: string): Homophones {
  build()
  const t = pinyin(ch, { toneType: 'num', type: 'array' })[0] ?? ''
  const b = pinyin(ch, { toneType: 'none', type: 'array' })[0] ?? ''
  const sameTone = (toneTable?.get(t) ?? []).filter((x) => x !== ch)
  const inTone = new Set(sameTone)
  const sameSound = (baseTable?.get(b) ?? []).filter((x) => x !== ch && !inTone.has(x))
  return { sameTone, sameSound }
}

/** 两个字读音一样吗（声调也算）。用来验收模型给的替换 */
export function isHomophone (a: string, b: string): boolean {
  if (a === b) return false
  return pinyin(a, { toneType: 'num', type: 'array' })[0] === pinyin(b, { toneType: 'num', type: 'array' })[0]
}

/**
 * 兜底挑一个。**确定性**：同一个字永远挑到同一个替身，
 * 于是同一篇文案重跑两次结果一致——否则用户会发现"我什么都没改，名字却变了"。
 *
 * 挑不出来（那 0.27% 的字）返回 null，交给人。
 */
export function pickHomophone (ch: string): string | null {
  const { sameTone, sameSound } = homophonesOf(ch)
  return sameTone[0] ?? sameSound[0] ?? null
}
