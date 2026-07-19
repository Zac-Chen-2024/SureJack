import { create } from 'zustand'
import { api, ApiError } from '../api/client'

export interface Asset {
  id: string
  projectId: string
  kind: 'video' | 'bgm' | 'voice' | 'srt' | 'bgtrack' | 'export'
  path: string
  originalName: string
  size: number
  durationMs: number | null
  createdAt: string
}

export interface JobState {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  error?: string
}

/**
 * 生成配音接口的响应。字段要与 src/tts/routes.ts 的返回体保持一致——
 * 前后端类型不同步是这个项目踩过的坑。
 */
export interface VoiceResult {
  ttsState: string
  durationMs: number
  wordCount: number
  /** 实际分了几段。1 表示文案不长，走的是直通路径。 */
  segmentCount: number
}

const VOICE_EXT = ['.mp3', '.wav', '.m4a', '.aac']

/** 拖进来的一堆文件分门别类的结果 */
export interface DropClassification {
  voice: File | null
  srt: File | null
  /** 认不出来或多余的文件名。**不静默丢弃**，要在界面上说出来 */
  rejected: string[]
}

/**
 * 按扩展名自动分辨拖进来的文件谁是配音、谁是字幕。
 *
 * 用户一次把两个文件一起拖进来就该能用，不该让他分两个框各拖一次——
 * 扩展名已经把答案写在文件名上了。
 *
 * 同种拖了两个只取第一个：配音和字幕各只能有一份（后端也是替换语义），
 * 多出来的进 rejected 让用户知道它被忽略了，而不是猜哪个生效。
 */
export function classifyDroppedFiles (files: File[]): DropClassification {
  let voice: File | null = null
  let srt: File | null = null
  const rejected: string[] = []
  for (const f of files) {
    const lower = f.name.toLowerCase()
    const dot = lower.lastIndexOf('.')
    const ext = dot === -1 ? '' : lower.slice(dot)
    if (ext === '.srt') {
      if (srt === null) srt = f
      else rejected.push(f.name)
    } else if (VOICE_EXT.includes(ext)) {
      if (voice === null) voice = f
      else rejected.push(f.name)
    } else {
      rejected.push(f.name)
    }
  }
  return { voice, srt, rejected }
}

/**
 * 只齐了一半时告诉用户还差什么。
 *
 * 一个都没有时【不提示】——那是还没开始拖的初始状态，先报错只会吓人。
 */
export function missingHint (has: { hasVoice: boolean; hasSrt: boolean }): string | null {
  if (has.hasVoice && has.hasSrt) return null
  if (has.hasVoice) return '已收到配音，还差字幕文件（.srt）'
  if (has.hasSrt) return '已收到字幕，还差配音文件（mp3 / wav / m4a / aac）'
  return null
}

/** POST /api/projects/:id/adopt-srt 的响应。字段与 src/projects/routes.ts 对齐 */
export interface AdoptResult {
  cueCount: number
  durationMs: number
  subtitleMode: 'line'
  /** 是否把 SRT 正文回填进了文案区 */
  scriptFilled: boolean
  warning: string | null
}

/**
 * 背景轨的状态。字段与 GET /api/projects/:id/bg-track 一一对应
 * （src/compose/prebuild.ts 的 BgTrackInfo）——前后端类型不同步是这个
 * 项目踩过的坑。
 */
export interface BgTrack {
  state: 'none' | 'building' | 'ready' | 'error'
  /** ready 时才有。预览用 `/api/assets/<id>` 播它 */
  assetId: string | null
}

/**
 * 预览画框下面那句话。null = 不用说话（背景就在画面里）。
 *
 * ⚠️【error 那句必须把"导出不受影响"说出来】。预拼只是个优化，它失败了
 * 后端会在导出时回退到即时生成（src/queue/routes.ts）。文案要是只说
 * "背景生成失败"，用户会以为片子导不出来、于是不敢点导出——一个后台
 * 优化把主流程吓停了，比不做这个优化还糟。
 */
export function bgTrackNotice (bg: BgTrack | null): string | null {
  switch (bg?.state) {
    case 'ready':
      return null
    case 'building':
      return '背景生成中…拼好后这里会直接播成片用的那条背景。'
    case 'error':
      return '预览暂无背景，导出时会重新生成，成片不受影响。'
    default:
      // none，以及状态还没拉回来的那一瞬间。保守说法，且永远为真。
      return '预览只放字幕和配音。背景在导出时按公式自动拼，成片里会有。'
  }
}

/** 预览的 `<video>` 该指向哪儿。没拼好就【不给 src】，别去请求一个不存在的素材。 */
export function bgTrackSrc (bg: BgTrack | null): string | null {
  if (bg?.state !== 'ready' || bg.assetId === null) return null
  return `/api/assets/${bg.assetId}`
}

/** 还要不要接着问。终态就停——两个用户的机器不该白跑一串请求。 */
export function shouldPollBgTrack (bg: BgTrack | null): boolean {
  return bg === null || bg.state === 'building'
}

/**
 * ⚠️ 这里的 upload 【只给配音和字幕用】，不是素材上传。
 *
 * 素材是 data/library/ 里那 210 个本地文件，用户只能选、不能传（见
 * store/library.ts）——背景视频/BGM 的上传动作连同界面一起删掉了，
 * **不要顺手加回来**。配音和字幕是另一回事：那是用户自己的内容，
 * 本来就该能传进来。两者别混。
 */
interface PipelineState {
  assets: Asset[]
  /** 背景轨预拼状态。null = 本次会话还没问过 */
  bgTrack: BgTrack | null
  job: JobState | null
  voiceBusy: boolean
  /** 最近一次生成配音分了几段。null 表示本次会话还没生成过。 */
  voiceSegmentCount: number | null
  error: string | null
  /** 自备配音/字幕正在上传或派生 */
  byoBusy: boolean
  /** 只齐了一半时的提示。null = 没什么好说的 */
  byoHint: string | null
  /** 派生成功但有隐患（字幕比配音长）时的警告 */
  byoWarning: string | null
  /** 最近一次派生有没有回填文案。null = 本次会话还没派生过 */
  byoScriptFilled: boolean | null
  loadAssets: (projectId: string) => Promise<void>
  /** 问一次背景轨状态。**永远不抛、永远不置 error** */
  loadBgTrack: (projectId: string) => Promise<void>
  generateVoice: (projectId: string) => Promise<void>
  /** 拖进来的文件 → 上传 → 齐了就派生。返回是否真的派生了 */
  adoptFiles: (projectId: string, files: File[]) => Promise<boolean>
  startExport: (projectId: string) => Promise<void>
  reset: () => void
}

export const usePipeline = create<PipelineState>((set, get) => ({
  assets: [], bgTrack: null, job: null, voiceBusy: false,
  voiceSegmentCount: null, error: null,
  byoBusy: false, byoHint: null, byoWarning: null, byoScriptFilled: null,

  // 切换项目时清掉：这些都是「本次操作」的结果，跟着项目走会误导
  reset () {
    set({
      assets: [], bgTrack: null, job: null, voiceSegmentCount: null, error: null,
      byoBusy: false, byoHint: null, byoWarning: null, byoScriptFilled: null,
    })
  },

  async loadAssets (projectId) {
    const assets = await api.get<Asset[]>(`/api/projects/${projectId}/assets`)
    set({ assets })
  },

  /*
   * 【失败就当"还没到时候"】。500 或者断网时我们根本不知道背景轨怎么样，
   * 说 error 是在编造一个自己没看见的失败；而占用那条红色 error 更糟——
   * 那是给导出/配音失败留的，一次拉状态失败不该长得像片子出问题了。
   */
  async loadBgTrack (projectId) {
    try {
      set({ bgTrack: await api.get<BgTrack>(`/api/projects/${projectId}/bg-track`) })
    } catch {
      set({ bgTrack: { state: 'none', assetId: null } })
    }
  },

  async generateVoice (projectId) {
    set({ voiceBusy: true, voiceSegmentCount: null, error: null })
    try {
      const r = await api.post<VoiceResult>(`/api/projects/${projectId}/voice`)
      set({ voiceSegmentCount: r.segmentCount })
      await get().loadAssets(projectId)
      // 后端这时刚把背景轨排进队列，问一次好让预览立刻显示「背景生成中」
      await get().loadBgTrack(projectId)
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '配音失败' })
    } finally {
      set({ voiceBusy: false })
    }
  },

  /**
   * 自备路径的完整动作：分辨 → 上传 → 凑齐了就派生。
   *
   * 【凑齐与否看服务端的素材列表，不看这一把拖了几个文件】：用户完全
   * 可能先拖配音、隔一会儿再拖字幕，第二次就该直接成功。上传完重新拉
   * 一次列表，两种 kind 都在才调 adopt-srt。
   *
   * 【明知不齐就不调后端】：那只会换回一个可预料的 400。前端已经知道
   * 缺什么，直接说，少一次往返也少一次「红色报错」的惊吓。
   */
  async adoptFiles (projectId, files) {
    set({ byoBusy: true, error: null, byoHint: null, byoWarning: null })
    try {
      const { voice, srt, rejected } = classifyDroppedFiles(files)
      if (voice === null && srt === null) {
        set({ error: `认不出这些文件：${rejected.join('、')}。请拖入配音（mp3 / wav / m4a / aac）和字幕（.srt）` })
        return false
      }
      if (rejected.length > 0) {
        set({ byoHint: `已忽略：${rejected.join('、')}` })
      }

      // 顺序固定先配音后字幕，纯粹为了可预期（测试和日志都好读）
      if (voice !== null) await api.upload<Asset>(`/api/projects/${projectId}/assets?kind=voice`, voice)
      if (srt !== null) await api.upload<Asset>(`/api/projects/${projectId}/assets?kind=srt`, srt)

      await get().loadAssets(projectId)
      const assets = get().assets
      const hasVoice = assets.some((a) => a.kind === 'voice')
      const hasSrt = assets.some((a) => a.kind === 'srt')
      if (!hasVoice || !hasSrt) {
        set({ byoHint: missingHint({ hasVoice, hasSrt }) })
        return false
      }

      const r = await api.post<AdoptResult>(`/api/projects/${projectId}/adopt-srt`)
      set({ byoWarning: r.warning, byoScriptFilled: r.scriptFilled, byoHint: null })
      // 自备配音这条路同样触发预拼，预览要跟上
      await get().loadBgTrack(projectId)
      return true
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '导入配音和字幕失败' })
      return false
    } finally {
      set({ byoBusy: false })
    }
  },

  async startExport (projectId) {
    set({ error: null })
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/api/projects/${projectId}/export`)
      set({ job: { jobId, status: 'queued', progress: 0 } })

      // SSE 订阅进度。用原生 EventSource——它自带重连，且我们只需单向接收。
      const es = new EventSource(`/api/jobs/${jobId}/stream`, { withCredentials: true })
      es.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as JobState
        set({ job: e })
        if (e.status === 'done' || e.status === 'error') {
          es.close()
          if (e.status === 'done') void get().loadAssets(projectId)
        }
      }
      es.onerror = () => { es.close() }
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '导出失败' })
    }
  },
}))
