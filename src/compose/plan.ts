/**
 * 三段式背景排布算法。
 *
 * 给定配音总长和三个视频桶的素材，算出「用哪些片、从哪一秒起、各取多久」，
 * 拼出一条与配音**精确等长**的背景轨：开头 → 常规 → 地铁跑酷。
 *
 * 这是纯函数，不碰文件系统、不调 ffmpeg、不查数据库。所有 IO 留给 build.ts。
 */

/**
 * 素材条目。
 *
 * Task 2 落地后应改为从 library 模块 import（`src/library/scan.ts` 会导出
 * 同名同结构的 `LibraryItem`），这里先本地声明以便并行开发。
 * 结构是一致的，届时删掉这段声明、换成 import 即可，调用方无需改动。
 */
export interface LibraryItem {
  id: string
  bucket: string
  filename: string
  durationMs: number
  sizeBytes: number
}

/** 一个片段：从素材 itemId 的 startMs 处截取 takeMs 毫秒。 */
export interface Segment {
  itemId: string
  startMs: number
  takeMs: number
}

export interface ComposePlan {
  segments: Segment[]
  /** 所有片段 takeMs 之和，等于传入的配音总长。 */
  totalMs: number
}

export interface Buckets {
  opening: readonly LibraryItem[]
  regular: readonly LibraryItem[]
  parkour: readonly LibraryItem[]
}

/**
 * 【老项目的比例】：开头 27% / 常规 27% / 跑酷 46%。
 *
 * ⚠️【这个数永远不能动】。它是 layout_ratio_json 为 NULL 的项目回落到的那一组
 * ——也就是加"存比例"这件事之前建的所有片子。改一个小数点，她盘上每一条
 * 片子的排布就变了，母带指纹跟着变，开机补合会把它们全部重烧一遍。
 */
export const LEGACY_LAYOUT_RATIO: readonly [number, number, number] = [0.27, 0.27, 0.46]

/**
 * 【新建项目用的比例】：开头 15% / 常规 39% / 跑酷 46%。
 *
 * 开头从 27% 缩到 15%（用户 2026-08-15 定的），空出来的 12 个点**全给常规**，
 * 跑酷那 46% 一分不动。
 *
 * ⚠️【改这个数只影响以后新建的项目】。每条片子在配音完成那一刻把当时的
 * 比例写进 layout_ratio_json，之后一辈子用自己那一组。
 */
export const DEFAULT_RATIO: readonly [number, number, number] = [0.15, 0.39, 0.46]

/**
 * 把库里存的那串 JSON 变回三元组。
 *
 * ⚠️【读不出来一律回落到 LEGACY_LAYOUT_RATIO,绝不抛】。这一列为 NULL 的
 * 是加"存比例"之前建的所有片子,它们本来就该走老比例;而一串坏 JSON
 * 也不该让用户连片子都合不出来——退回老比例最多是排布不合新口味,
 * 抛异常是整条链路断掉。
 */
/** 比例之和允许的浮点误差。0.333+0.333+0.334 这类写法不该被判为非法。 */
const RATIO_EPSILON = 1e-6

export function parseLayoutRatio (json: string | null): readonly [number, number, number] {
  if (json === null || json === '') return LEGACY_LAYOUT_RATIO
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v) || v.length !== 3) return LEGACY_LAYOUT_RATIO
    const r = v.map(Number)
    if (r.some((x) => !Number.isFinite(x) || x < 0)) return LEGACY_LAYOUT_RATIO
    if (Math.abs(r[0]! + r[1]! + r[2]! - 1) > RATIO_EPSILON) return LEGACY_LAYOUT_RATIO
    return [r[0]!, r[1]!, r[2]!]
  } catch {
    return LEGACY_LAYOUT_RATIO
  }
}



/**
 * 按比例把 totalMs 切成三段的目标时长。
 *
 * 前两段用 Math.floor，**最后一段吃掉全部余数**——这样三段之和恒等于
 * totalMs，一毫秒都不丢。四舍五入或者三段各自取整都会漏掉余数：
 * 123457 × 0.27 = 33333.39，两段丢掉的 0.78ms 加上第三段的舍入，
 * 足以让成片结尾黑一帧。
 */
function splitTargets (totalMs: number, ratio: readonly [number, number, number]): [number, number, number] {
  const a = Math.floor(totalMs * ratio[0])
  const b = Math.floor(totalMs * ratio[1])
  return [a, b, totalMs - a - b]
}

/**
 * 从一个桶里按顺序铺满 needMs 毫秒。
 *
 * 开头/常规桶是几十秒的短片，会连着取好几片（拼接）；地铁跑酷桶是
 * GB 级长录屏，一片就够，自然只产生一个片段（截取）——两种用法是
 * 同一套逻辑，不需要分开写。
 *
 * @param cursor 桶内下一个可用素材的下标。用过的片不回头，避免重复。
 * @returns 实际铺满的毫秒数、新的游标、产生的片段
 */
function fillFrom (
  items: readonly LibraryItem[],
  cursor: number,
  needMs: number,
): { filledMs: number; cursor: number; segments: Segment[] } {
  const segments: Segment[] = []
  let filled = 0
  let i = cursor
  while (filled < needMs && i < items.length) {
    const it = items[i]
    i += 1
    // 时长为 0 或缺失的素材（探测失败的残留行）直接跳过，否则会空转
    if (it === undefined || it.durationMs <= 0) continue
    const take = Math.min(it.durationMs, needMs - filled)
    segments.push({ itemId: it.id, startMs: 0, takeMs: take })
    filled += take
  }
  return { filledMs: filled, cursor: i, segments }
}

/**
 * 最后手段：素材总量不够铺满整条轨时循环复用。
 *
 * 规则 4 说「不循环重复」，指的是正常情况；但如果三个桶加起来都不够长，
 * 除了循环没有别的办法——总长必须精确等于配音，宁可重复也不能短。
 */
function fillByLooping (pool: readonly LibraryItem[], needMs: number): Segment[] {
  const segments: Segment[] = []
  let filled = 0
  let i = 0
  while (filled < needMs) {
    const it = pool[i % pool.length]
    i += 1
    if (it === undefined) break
    const take = Math.min(it.durationMs, needMs - filled)
    segments.push({ itemId: it.id, startMs: 0, takeMs: take })
    filled += take
  }
  return segments
}

/**
 * 排布一条与配音等长的背景轨。
 *
 * @param totalMs 配音总长（整数毫秒）。输出的片段时长之和精确等于它。
 * @param buckets 三个视频桶，每个桶内按想要的播放顺序排列。
 * @param ratio 三段占比，默认 27/27/46。
 */
export interface PlanOptions {
  /**
   * 【开头段必须正好这么长】。给了就不按比例算开头，也不允许缺口顺延。
   *
   * 为「重选开头」服务：只要开头和后半段的分界永远落在同一时刻，
   * 后半段就能原样复用，重选时只重烧开头那一两分钟。
   * 而分界要固定，开头就必须是【定长】的——按比例算出来的那个数不是定长，
   * 它其实是 min(比例 × 总长, 挑选素材的总时长)，换一批素材就会漂
   * （实测同样挑 6 个，换一批从 78.0 秒变成 72.5 秒）。
   *
   * ⚠️【不给就完全走老逻辑】。这是给老项目的隔离：它们的排布、
   * 因而母带指纹，必须逐字节不变，否则开机补合会把它们全部重烧。
   */
  openingMs?: number
}

export function planBackground (
  totalMs: number,
  buckets: Buckets,
  ratio: readonly [number, number, number] = DEFAULT_RATIO,
  opts: PlanOptions = {},
): ComposePlan {
  if (!Number.isInteger(totalMs) || totalMs <= 0) {
    throw new Error(`配音时长必须是正整数毫秒，收到：${totalMs}`)
  }
  if (ratio.some((r) => !(r >= 0)) || Math.abs(ratio[0] + ratio[1] + ratio[2] - 1) > RATIO_EPSILON) {
    throw new Error(`三段比例必须非负且相加为 1，收到：${ratio.join(', ')}`)
  }

  const order: readonly (readonly LibraryItem[])[] = [buckets.opening, buckets.regular, buckets.parkour]
  const usable = order.map((items) => items.filter((it) => it.durationMs > 0))
  if (usable.every((items) => items.length === 0)) {
    throw new Error('素材库里没有可用的视频素材，无法排布背景轨')
  }

  const fixedOpening = opts.openingMs
  if (fixedOpening !== undefined
      && (!Number.isInteger(fixedOpening) || fixedOpening <= 0 || fixedOpening >= totalMs)) {
    throw new Error(`开头段时长必须是 0 到 ${totalMs} 之间的整数毫秒，收到：${fixedOpening}`)
  }

  /*
   * 定长开头：开头吃掉 fixedOpening，剩下的时长【按常规和跑酷原本的比例
   * 再分一次】。直接沿用原比例的话，两者之和不等于剩余时长，
   * 差额会掉进最后那个 carry 里，等于把定长的意义抵消掉一部分。
   */
  const targets = fixedOpening === undefined
    ? splitTargets(totalMs, ratio)
    : (() => {
        const rest = totalMs - fixedOpening
        const r1 = ratio[1] + ratio[2]
        const b = r1 > 0 ? Math.floor(rest * (ratio[1] / r1)) : 0
        return [fixedOpening, b, rest - b] as [number, number, number]
      })()
  const segments: Segment[] = []

  /*
   * 缺口顺延（规则 4）：某个桶铺不满自己那一段时，剩下的时长交给下一段，
   * 而不是在这个桶里循环重复。开头桶只有 90 秒、目标 178 秒时，
   * 多出来的 88 秒会一路推到地铁跑酷。
   */
  let carry = 0
  for (let phase = 0; phase < 3; phase += 1) {
    const items = usable[phase] ?? []
    const need = (targets[phase] ?? 0) + carry
    const r = fillFrom(items, 0, need)
    segments.push(...r.segments)
    carry = need - r.filledMs

    /*
     * 【定长开头铺不满就报错，不顺延】。顺延的话开头会变短，
     * 分界跟着漂，后半段就复用不了了——那正是这个选项要消灭的东西。
     *
     * 调用方（挑开头那一屏）负责在用户确认之前就挡住"素材不够"：
     * 界面上实时显示"已选 78 秒 / 需要 153 秒"，凑够了才让确认。
     * 所以走到这里还不够，属于调用方失职，要明确地炸出来，
     * 而不是默默产出一条分界漂了的片子。
     */
    if (phase === 0 && fixedOpening !== undefined && carry > 0) {
      throw new Error(
        `开头素材不够铺满 ${Math.round(fixedOpening / 1000)} 秒，还差 ${Math.round(carry / 1000)} 秒，请多挑几段`)
    }
  }

  // 三个桶加起来都不够长，只能循环（规则 5）
  if (carry > 0) {
    segments.push(...fillByLooping(usable.flat(), carry))
  }

  return { segments, totalMs }
}
