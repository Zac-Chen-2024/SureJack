import { planBackground, type LibraryItem } from '../compose/plan.js'
import type { LibraryDb } from './library-db.js'
import { listBucket } from './scan.js'

/**
 * 三段排布中的一段。比 compose/plan.ts 的 Segment 多了 filename/bucket——
 * 前端要显示"用了哪些文件"，补在这里省得它再查一次库。
 */
export interface BgSegment {
  itemId: string
  filename: string
  bucket: string
  /** 从源文件的哪一刻开始截 */
  startMs: number
  /** 截多长 */
  takeMs: number
}

export interface BackgroundPlan {
  segments: BgSegment[]
  totalMs: number
}

/**
 * 32 位整数哈希（FNV-1a 风格）：把项目 id 揉成一个种子。
 *
 * `>>> 0` 是为了把 Math.imul 产出的有符号数转成无符号——
 * 种子必须是稳定的非负整数，负数会让 mulberry32 的首次推进走另一条路。
 */
export function seedFrom (s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * mulberry32：小、快、够随机的确定性伪随机数发生器。
 *
 * ⚠️【绝不能用 Math.random()】——它不可复现，同一个项目每次算出的排布
 * 都不一样：用户刷新一次预览条就换一批素材，而导出时又是第三种结果。
 * 确定性是这里的硬需求，不是优化。
 */
export function rng (seed: number): () => number {
  let s = seed
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher-Yates 洗牌。返回新数组，**不改入参**。
 *
 * 从后往前、`j` 取 `[0, i]` 闭区间——写成 `[0, i)` 或 `[0, n)` 都会引入偏置，
 * 让某些元素永远到不了某些位置。
 */
export function shuffled<T> (items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i]
    const b = out[j]
    // noUncheckedIndexedAccess：i/j 都在界内，但类型上仍需窄化，不用 `!` 绕
    if (a === undefined || b === undefined) continue
    out[i] = b
    out[j] = a
  }
  return out
}

/** 参与背景视频排布的三个桶，顺序即成片顺序。背景音乐桶不在其中。 */
export const OPENING_BUCKET = '1-开头'
const VIDEO_BUCKETS = [OPENING_BUCKET, '2-常规', '3-地铁跑酷'] as const

/**
 * 续集的背景【只用开头段 + 地铁跑酷】，跳过常规桶。
 *
 * 为什么不同：主片要靠常规素材撑起十分钟的观感变化；续集的观众是冲着
 * "接着看"来的，前面几段开头素材做个过渡，剩下全程地铁跑酷压着，
 * 注意力留在故事上就够了。这是内容策略，不是技术限制。
 */
export const SEQUEL_OPENING_CLIPS = 5

/**
 * 素材库里到底有没有可用的背景视频。
 *
 * 供路由在算排布之前先问一句：**"库是空的"和"配音没好"是两回事**，
 * 前者要提示去扫库，后者是正常的中间态。分开判断，别让调用方靠捕获
 * 异常消息来区分——那种判别方式一改文案就失效。
 */
export function hasVideoMaterials (db: LibraryDb): boolean {
  return VIDEO_BUCKETS.some((b) => listBucket(db, b).some((it) => it.durationMs > 0))
}

/**
 * 给一个项目算出背景轨排布。
 *
 * 配音未就绪（ttsDurationMs 为 null 或 0）时返回空排布而不是抛错——
 * 背景长度由配音决定，"还没配音"是正常的中间态，不是错误。
 *
 * **每个项目用不同的素材组合，同一项目永远一致。** 开头桶 68 个、常规桶
 * 124 个片段，公式没规定选哪几个；按桶内固定顺序取的话每条视频的开头都是
 * 同一批片子，做营销号显然不要这个效果。所以在调 planBackground() 之前，
 * 先用【项目 id 派生的种子】把桶内顺序打乱。
 *
 * ⚠️ 随机性完全隔离在 planBackground() 之上——那个纯函数一行都不用改
 * （它已有 22 个测试且做过变异测试）。它只管"按给定顺序铺满"，
 * "顺序是什么"由这里决定。
 *
 * ⚠️【已知取舍】排布不落库、每次现算，所以**扫进新素材会让已有项目的
 * 排布改变**（被打乱的数组内容变了，Fisher-Yates 的结果自然跟着变）。
 * 换来的是"项目只存引用、不复制 4.7GB 素材"。
 * 作者亲手挑过开头的项目不受这条影响——那份选择是落库的（opts.openingPick），
 * 扫库怎么变都不会动它。常规段和跑酷段仍然现算。
 */
export function planProjectBackground (
  db: LibraryDb, projectId: string, ttsDurationMs: number | null,
  opts: {
    sequel?: boolean
    /**
     * 作者亲手挑的开头素材 id，有序。给了就按这个顺序铺开头段，不洗牌。
     * 空数组/不给 = 走默认随机。
     */
    openingPick?: readonly string[]
    /**
     * 排默认开头时要避开的素材 id。**给续集用**：
     * 两集各用自己的项目 id 当种子，顺序确实不同，但都从同一个 68 段的桶里抓，
     * 主片抓十几段、续集抓 5 段，按概率平均会撞上一段左右。
     * 用户要求两集开头不能一样，所以靠显式剔除，不靠随机自然分开。
     */
    excludeOpening?: readonly string[]
  } = {},
): BackgroundPlan {
  if (ttsDurationMs === null || ttsDurationMs <= 0) return { segments: [], totalMs: 0 }

  /*
   * 【在这里取整】：这是「实测出来的时长」和「要求整数的纯算法」之间的边界。
   *
   * planBackground 要正整数才能保证三段之和精确等于总长，这个要求是对的，
   * 不该为了迁就上游而放宽。但上游的时长是量出来的：Azure 的 HNS 除以 10000
   * 会出小数（实测一条 1 分钟配音给了 65087.5ms），历史数据里也已经存着
   * 这样的值。源头已经修成整数（azure.ts 的 hnsToMs），这一道是边界防护，
   * 防止任何新的小数来源再把整条背景排布打成 500。
   */
  const totalMs = Math.round(ttsDurationMs)

  const rand = rng(seedFrom(projectId))
  // 三个桶依次用同一条随机流打乱：流是确定的，所以整体仍然可复现
  const [openingAll = [], regularAll = [], parkour = []] =
    VIDEO_BUCKETS.map((b) => shuffled(listBucket(db, b), rand))

  /*
   * 【续集换一套公式】：开头桶只取 5 段，常规桶整个不用，剩下的全给
   * 地铁跑酷。实现上不需要新算法——比例给成 [1,0,0]，开头桶又只剩 5 段，
   * planBackground 的"缺口顺延"会把填不满的部分一路推到地铁跑酷，
   * 结果正好是"几段开头 + 全程跑酷"。那个纯函数一行都不用改。
   */
  /*
   * 【人挑的优先，其次剔除要避开的，最后才是洗好的默认顺序】。
   * 人挑的清单里可以有重复（同一段开头连着用两次是合理的），
   * 所以按 id 逐个映射而不是 filter——filter 会把重复项吃掉。
   */
  const pick = opts.openingPick ?? []
  const openingById = new Map(openingAll.map((it) => [it.id, it]))
  const exclude = new Set(opts.excludeOpening ?? [])
  const openingPool = pick.length > 0
    ? pick.map((id) => openingById.get(id)).filter((it): it is LibraryItem => it !== undefined)
    : openingAll.filter((it) => !exclude.has(it.id))

  const opening = opts.sequel && pick.length === 0
    ? openingPool.slice(0, SEQUEL_OPENING_CLIPS)
    : openingPool
  const regular = opts.sequel ? [] : regularAll

  const byId = new Map<string, LibraryItem>()
  for (const it of [...opening, ...regular, ...parkour]) byId.set(it.id, it)

  // 素材库为空时 planBackground 会抛错——那是"库还没扫过"，
  // 和"配音没好"是两回事，不能都压成空排布，否则运维看不出该去扫库
  const plan = opts.sequel
    ? planBackground(totalMs, { opening, regular, parkour }, [1, 0, 0])
    : planBackground(totalMs, { opening, regular, parkour })

  return {
    totalMs: plan.totalMs,
    segments: plan.segments.map((s) => {
      const item = byId.get(s.itemId)
      // 排布里的 id 必然来自刚才传进去的三个桶，取不到只可能是内部 bug。
      // 【不用空串兜底】——那样前端会显示一片空白的段，问题被藏起来
      if (item === undefined) throw new Error(`排布引用了不存在的素材：${s.itemId}`)
      return {
        itemId: s.itemId,
        filename: item.filename,
        bucket: item.bucket,
        startMs: s.startMs,
        takeMs: s.takeMs,
      }
    }),
  }
}

/**
 * 解析落库的开头清单。存的是 JSON 数组，坏数据一律当"没挑"处理——
 * 这一列只影响挑素材，为它抛异常会把整条烧录链路带崩。
 */
export function parseOpeningPick (json: string): string[] {
  if (json === '') return []
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 一份排布里，开头段用到的素材 id（有序、含重复） */
export function openingIdsOf (plan: BackgroundPlan): string[] {
  return plan.segments.filter((s) => s.bucket === OPENING_BUCKET).map((s) => s.itemId)
}
