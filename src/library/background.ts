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
const VIDEO_BUCKETS = ['1-开头', '2-常规', '3-地铁跑酷'] as const

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
 * 换来的是"项目只存引用、不复制 4.7GB 素材"。真要钉死，得在项目上存一列
 * 排布快照——那是另一个任务。
 */
export function planProjectBackground (
  db: LibraryDb, projectId: string, ttsDurationMs: number | null,
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
  const [opening = [], regular = [], parkour = []] =
    VIDEO_BUCKETS.map((b) => shuffled(listBucket(db, b), rand))

  const byId = new Map<string, LibraryItem>()
  for (const it of [...opening, ...regular, ...parkour]) byId.set(it.id, it)

  // 素材库为空时 planBackground 会抛错——那是"库还没扫过"，
  // 和"配音没好"是两回事，不能都压成空排布，否则运维看不出该去扫库
  const plan = planBackground(totalMs, { opening, regular, parkour })

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
