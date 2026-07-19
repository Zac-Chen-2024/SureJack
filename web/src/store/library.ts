import { create } from 'zustand'
import { api, ApiError } from '../api/client'

/**
 * 素材库。**只读**——素材是 data/library/ 里那 210 个本地文件，
 * 用户只能选、不能传。这个 store 里没有、也永远不该有上传。
 *
 * 类型与后端 src/library/ 的返回体同构。这里重新声明而不是跨目录 import：
 * web/ 是独立的 TS 工程（tsconfig.app.json 的 include 只有 src），
 * 跟 store/pipeline.ts 重新声明 Asset 是同一个约定。
 */
export interface LibraryItem {
  id: string
  bucket: string
  filename: string
  durationMs: number
  sizeBytes: number
}

/** 三段式背景排布中的一段 */
export interface BgSegment {
  itemId: string
  filename: string
  bucket: string
  /** 从源文件的哪一刻开始截 */
  startMs: number
  /** 截多长。分段条的宽度就按它等比分 */
  takeMs: number
}

export interface BackgroundPlan {
  segments: BgSegment[]
  totalMs: number
}

/** BGM 所在的桶名。后端白名单里的四个字符串之一，不要拼写成别的 */
export const BGM_BUCKET = '背景音乐'

/**
 * 从 BGM 文件名拆出曲名和标签：**第一个空格前是曲名，其余是标签**。
 *
 *   `一笑倾城 现言 甜文.wav` → { title: '一笑倾城', tags: '现言 甜文' }
 *
 * 素材包里的文件名是不透明字符串（有 `6月1日(8.mp4` 这种残缺名），
 * 所以这里只做「切一刀」这一件事，不做任何清洗或纠正：
 * 没有空格就整个当曲名，标签为空。扩展名按最后一个点去掉，
 * 用 lastIndexOf 而不是 split('.')[1]——曲名里可能本来就带点。
 */
export function parseBgmName (filename: string): { title: string; tags: string } {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const m = /\s+/.exec(stem)
  if (m === null) return { title: stem, tags: '' }
  return { title: stem.slice(0, m.index), tags: stem.slice(m.index + m[0].length).trim() }
}

/** 分段条上的一段：一个桶的全部片段合起来算作「一段」 */
export interface BgPhase {
  bucket: string
  /** 这一段总共多长 */
  takeMs: number
  /** 由几个源片段拼成。界面上不列它们，但这个数字说明了"这一段不是一整条" */
  clipCount: number
}

/**
 * 把排布收成【三段】。
 *
 * ⚠️ 这是计划里没说清的一处：三段式公式指的是三个**阶段**
 * （开头 → 常规 → 地铁跑酷），不是三个片段。后端真实返回的是 38 个
 * 片段——每个阶段由十几个几秒长的源片剪接而成。直接把 segments 一段一格
 * 画出来会得到 38 条头发丝，说明行也会变成五行密密麻麻的时间码，
 * 「全自动」的观感彻底没了。
 *
 * 所以按桶合并：**相邻同桶的片段并成一段**。用相邻而不是全局分组，
 * 是因为顺序才是这条轨的含义——万一将来公式变成 A→B→A，
 * 全局分组会把它画成两段并谎称时间是连续的。
 */
export function groupPhases (segments: BgSegment[]): BgPhase[] {
  const out: BgPhase[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (last !== undefined && last.bucket === s.bucket) {
      last.takeMs += Math.max(0, s.takeMs)
      last.clipCount += 1
    } else {
      out.push({ bucket: s.bucket, takeMs: Math.max(0, s.takeMs), clipCount: 1 })
    }
  }
  return out
}

/**
 * 分段条各段的百分比宽度，按 takeMs 等比，**和恰好是 100**。
 *
 * 为什么要保证和为 100：三段是并排的 flex 子元素，各自 width: n%。
 * 独立四舍五入会累出 ±1% 的误差，条尾要么缺一道缝要么被挤出去换行。
 * 用最大余数法（Hare quota）把误差集中分配掉：先取整数部分，
 * 余下的名额发给小数部分最大的那几段。
 */
export function segmentShares (phases: BgPhase[]): number[] {
  const total = phases.reduce((sum, s) => sum + Math.max(0, s.takeMs), 0)
  if (total <= 0) return phases.map(() => 0)

  const exact = phases.map((s) => (Math.max(0, s.takeMs) / total) * 100)
  const floors = exact.map((v) => Math.floor(v))
  let remaining = 100 - floors.reduce((a, b) => a + b, 0)

  // 按小数部分从大到小发放剩余名额
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)

  const out = [...floors]
  for (const { i } of order) {
    if (remaining <= 0) break
    out[i] = (out[i] ?? 0) + 1
    remaining -= 1
  }
  return out
}

/** `m:ss`。背景片段动辄几分钟，不需要字幕列表那种一位小数 */
export function formatClock (ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const s = Math.floor(safe / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 分段条下面那行说明：`0:18 开头 · 0:18 常规 · 0:30 地铁跑酷` */
export function describePlan (phases: BgPhase[]): string {
  return phases
    .map((p) => `${formatClock(p.takeMs)} ${bucketLabel(p.bucket)}`)
    .join(' · ')
}

/** 桶名去掉排序前缀：`3-地铁跑酷` → `地铁跑酷` */
export function bucketLabel (bucket: string): string {
  return bucket.replace(/^\d+-/, '')
}

interface LibraryState {
  /** 背景音乐桶的 9 首。素材库是全局公用的，切项目不用重取 */
  bgm: LibraryItem[]
  bgmLoading: boolean
  /** 素材库整体不可用时的提示（含「库是空的，去扫一下」） */
  error: string | null

  plan: BackgroundPlan | null
  planLoading: boolean
  /** 排布算不出来的原因。素材库为空（409）时后端给的就是可操作的那句话 */
  planError: string | null

  loadBgm: () => Promise<void>
  loadPlan: (projectId: string) => Promise<void>
  /** 切项目时清排布——排布是按项目 id 定的，留着上一个项目的会误导 */
  resetPlan: () => void
}

export const useLibrary = create<LibraryState>((set) => ({
  bgm: [], bgmLoading: false, error: null,
  plan: null, planLoading: false, planError: null,

  resetPlan () { set({ plan: null, planError: null }) },

  async loadBgm () {
    set({ bgmLoading: true, error: null })
    try {
      const { items } = await api.get<{ items: LibraryItem[] }>(
        `/api/library/${encodeURIComponent(BGM_BUCKET)}`,
      )
      set({ bgm: items })
    } catch (e) {
      set({ bgm: [], error: e instanceof ApiError ? e.message : '素材库读取失败' })
    } finally {
      set({ bgmLoading: false })
    }
  },

  async loadPlan (projectId) {
    set({ planLoading: true, planError: null })
    try {
      /*
       * 配音没好时后端回 { segments: [], totalMs: 0 }，不是错误——
       * 那是正常中间态，界面显示「生成配音后自动排布」。
       * 真正的错误只有一个：素材库一条视频都没有，后端回 409，
       * 那句提示本身就是可操作的（去扫库），原样透出去。
       */
      const plan = await api.get<BackgroundPlan>(`/api/projects/${projectId}/background-plan`)
      set({ plan })
    } catch (e) {
      set({ plan: null, planError: e instanceof ApiError ? e.message : '背景排布读取失败' })
    } finally {
      set({ planLoading: false })
    }
  },
}))
