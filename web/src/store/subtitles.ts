import { create } from 'zustand'
import { api, ApiError } from '../api/client'

/**
 * 字幕的词级时间戳。与后端 src/types.ts 的 WordTiming 同构。
 * 这里重新声明而不是跨目录 import：web/ 是独立的 TS 工程（tsconfig.app.json
 * 的 include 只有 src），跟 store/pipeline.ts 里重新声明 Asset 是同一个约定。
 */
export interface WordTiming {
  text: string
  offsetMs: number
  durationMs: number
  isPunctuation: boolean
}

/** 一行字幕。推导数据——后端每次从词时间戳算出来，不入库。 */
export interface SubtitleLine {
  startMs: number
  endMs: number
  words: WordTiming[]
}

/** 把一行的词拼回可读文本。标点本身就是 word，直接顺序拼接即可。 */
export function lineText (line: SubtitleLine): string {
  return line.words.map((w) => w.text).join('')
}

/**
 * 时间戳格式化：`m:ss.s`（分不补零、秒补两位、保留一位小数）。
 *
 * 为什么保留一位小数：字幕行经常只有一两秒长，只显示到秒会出现连续
 * 几行时间戳一模一样，那一列就失去索引作用了。
 *
 * 为什么分钟不补零：免费层单次配音上限 10 分钟，分钟位实际只有一位，
 * 补零反而多出一列没有信息量的 0。列表侧用 tabular-nums + 右对齐保证
 * 竖直方向严格对齐，不依赖字符数相同。
 *
 * 负数和 NaN 一律钳到 0——时间戳是索引，宁可显示 0:00.0 也不能显示
 * `NaN:aN.a` 把整列排版撑坏。
 */
export function formatTimestamp (ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  // 先截断到 100ms，再拆分——否则 59.96s 会显示成 0:60.0
  const tenths = Math.floor(safe / 100)
  const m = Math.floor(tenths / 600)
  const s = Math.floor(tenths / 10) % 60
  const d = tenths % 10
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

/**
 * 当前播放时间落在第几行。返回下标，没有则 -1。
 *
 * 语义是「最后一个 startMs <= ms 的行」，不是「区间包含 ms 的行」：
 * 行与行之间有停顿间隙，如果按区间包含判定，每次说话停顿高亮就会消失
 * 一下，一整段读下来高亮在闪。按"最后一个已开始的行"判定，间隙里高亮
 * 停在刚念完的那行上，视觉是稳的。
 *
 * 二分查找——列表可能几百行，而这个函数每次播放时间更新都要跑。
 */
export function findCurrentLineIndex (lines: SubtitleLine[], ms: number): number {
  if (lines.length === 0) return -1
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.startMs <= ms) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

interface SubtitlesState {
  lines: SubtitleLine[]
  /** 当前播放时间。预览播放器负责推进它，列表订阅它做高亮 */
  currentMs: number
  /**
   * 跳转序号：每调用一次 seekTo 就 +1。
   *
   * 预览播放器需要区分两种 currentMs 变化：它自己播到那儿了（不该再 seek
   * 自己，否则每帧都在重置播放头），还是用户点了某一行要求跳过去。光看
   * currentMs 变了区分不出来，所以额外给一个单调递增的序号——播放器只在
   * 序号变化时执行跳转。
   */
  seekNonce: number
  loading: boolean
  error: string | null
  load: (projectId: string) => Promise<void>
  /** 用户请求跳转到某个时间点（点击字幕行）。这里只改 store，播放器订阅后执行 */
  seekTo: (ms: number) => void
  /** 播放器上报播放进度。不会触发跳转 */
  setCurrentMs: (ms: number) => void
  reset: () => void
}

const EMPTY: Pick<SubtitlesState, 'lines' | 'currentMs' | 'seekNonce' | 'loading' | 'error'> = {
  lines: [], currentMs: 0, seekNonce: 0, loading: false, error: null,
}

export const useSubtitles = create<SubtitlesState>((set) => ({
  ...EMPTY,

  reset () { set({ ...EMPTY }) },

  async load (projectId) {
    set({ loading: true, error: null })
    try {
      // 没生成配音时后端回 { lines: [] }，不是 404——空字幕是正常状态，
      // 不是错误，前端要靠这个区分"还没配音"和"请求挂了"。
      const { lines } = await api.get<{ lines: SubtitleLine[] }>(`/api/projects/${projectId}/subtitles`)
      set({ lines })
    } catch (e) {
      set({ lines: [], error: e instanceof ApiError ? e.message : '字幕加载失败' })
    } finally {
      set({ loading: false })
    }
  },

  seekTo (ms) {
    set((s) => ({ currentMs: Math.max(0, ms), seekNonce: s.seekNonce + 1 }))
  },

  setCurrentMs (ms) { set({ currentMs: Math.max(0, ms) }) },
}))
