import { createHash } from 'node:crypto'
import type { BgSegment } from '../library/background.js'
import type { AspectPreset } from '../types.js'

/**
 * 把母带的身份拆成【开头】和【后半段】两半。
 *
 * ── 为了回答一个问题 ────────────────────────────────────────────────
 * 用户重选了开头,盘上那条母带的后半段还能不能原样拿来用?
 * 能 → 只重烧开头那一两分钟再无损拼回去(约 2 分钟);
 * 不能 → 整条重烧(14 分钟)。
 *
 * ── 判据:后半段的指纹变没变 ────────────────────────────────────────
 * 只有【换开头素材】这一件事可以在后半段不变的前提下发生。文案改了、
 * 字幕改了、配音重做了、画幅换了——统统会让后半段也不一样,那就该整条重烧。
 *
 * ── 为什么是"全部输入减去开头那几段",而不是"切开的后半截" ──────────
 * 一个直觉的做法是把 ASS 按时间切成两半、各自哈希。**不要这么做**:
 * 切 ASS 要处理跨界的那一行、样式头、时间平移,每一处都是新的出错点,
 * 而它换来的精度毫无用处——字幕只要动了一个字,整条本来就该重烧。
 *
 * 所以这里【故意保守】:后半段的指纹含【整份 ASS】。字幕一变它就变,
 * 结论是"整条重烧",正确;开头素材一变它【不】变,结论是"后半段能复用",
 * 也正确。要判的那件事一次都没判错,而实现里没有一处需要切东西。
 */

/** 拆分需要的输入。刻意只收"母带层"的东西——BGM、封面这些不影响画面 */
export interface SplitInput {
  aspect: AspectPreset
  /** 全片时长。它变了后半段必然变 */
  durationMs: number
  /** ASS 全文(算指纹用的那一份) */
  ass: string
  /** 开头段在哪一毫秒结束 */
  boundaryMs: number
  /** 整条排布,按播放顺序 */
  segments: readonly BgSegment[]
  /** 母带层的其余输入,原样并进后半段的哈希 */
  rest: readonly unknown[]
}

export interface SplitFingerprints {
  /** 开头那一段的身份:换素材它就变 */
  head: string
  /** 后半段的身份:**只要它没变,盘上那条母带的后半段就能原样复用** */
  tail: string
  /** 开头包含前几段素材(切点)。给"只重烧开头"那一步用 */
  headSegmentCount: number
}

function sha (parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** 一段排布的可哈希表示 */
const segKey = (s: BgSegment): string => `${s.itemId}\0${s.startMs}\0${s.takeMs}`

/**
 * 排布在哪一段之后跨过分界。
 *
 * 开头段是【正好】铺满到分界的(见 compose/plan.ts 的 openingMs),所以
 * 累加取用时长必然在某一段的末尾正好等于分界。用累加而不是"数开头桶有几段",
 * 是因为前者不依赖桶的名字——万一以后开头段允许混别的桶,这里不用跟着改。
 *
 * @returns 开头包含的段数;对不上分界返回 null(这条片子不能拆)
 */
export function splitAt (segments: readonly BgSegment[], boundaryMs: number): number | null {
  if (!Number.isFinite(boundaryMs) || boundaryMs <= 0) return null
  let acc = 0
  for (let i = 0; i < segments.length; i++) {
    acc += segments[i]!.takeMs
    if (acc === boundaryMs) {
      // 【后面必须还有东西】。切在最后一段末尾的话后半段是空的,拼接毫无意义
      if (i === segments.length - 1) return null
      return i + 1
    }
    if (acc > boundaryMs) return null   // 跨过去了还没对齐:铺法和分界对不上
  }
  return null
}

/**
 * 算开头 / 后半段两份指纹。
 *
 * @returns 拆不开时返回 null——**这不是错误**,只意味着这条片子重选开头
 *          得整条重烧。老项目(没有分界)、自备背景视频、排布和分界对不上,
 *          都走这里。绝不抛。
 */
export function splitFingerprints (i: SplitInput): SplitFingerprints | null {
  const cut = splitAt(i.segments, i.boundaryMs)
  if (cut === null) return null

  const assHash = createHash('sha256').update(i.ass).digest('hex')
  const head = sha([
    'head', i.aspect.width, i.aspect.height, i.boundaryMs,
    i.segments.slice(0, cut).map(segKey), assHash, ...i.rest,
  ])
  /*
   * ⚠️ 后半段的指纹里【没有开头那几段】,这正是它的全部意义:
   * 换开头 → 只有 head 变,tail 一个字节都不动 → 后半段能复用。
   */
  const tail = sha([
    'tail', i.aspect.width, i.aspect.height, i.boundaryMs, i.durationMs,
    i.segments.slice(cut).map(segKey), assHash, ...i.rest,
  ])
  return { head, tail, headSegmentCount: cut }
}
