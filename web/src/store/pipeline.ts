import { create } from 'zustand'
import { api, ApiError } from '../api/client'

export interface Asset {
  id: string
  projectId: string
  kind: 'video' | 'bgm' | 'voice' | 'export'
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

/**
 * ⚠️ 这里【没有 upload】。
 *
 * 素材是 data/library/ 里那 210 个本地文件，用户只能选、不能传（见
 * store/library.ts）。上传背景视频/BGM 的那套动作连同界面一起删掉了——
 * 留着一个没人调的上传通道，下一个人看见就会顺手再把按钮加回来。
 *
 * 后端的上传路由仍在，因为老项目里可能还有当年传上去的 bg_mode='single'
 * 素材，导出要继续支持它们；但新数据不再从这个前端产生。
 */
interface PipelineState {
  assets: Asset[]
  job: JobState | null
  voiceBusy: boolean
  /** 最近一次生成配音分了几段。null 表示本次会话还没生成过。 */
  voiceSegmentCount: number | null
  error: string | null
  loadAssets: (projectId: string) => Promise<void>
  generateVoice: (projectId: string) => Promise<void>
  startExport: (projectId: string) => Promise<void>
  reset: () => void
}

export const usePipeline = create<PipelineState>((set, get) => ({
  assets: [], job: null, voiceBusy: false,
  voiceSegmentCount: null, error: null,

  // 切换项目时清掉：分段提示是「本次生成」的结果，跟着项目走会误导
  reset () { set({ assets: [], job: null, voiceSegmentCount: null, error: null }) },

  async loadAssets (projectId) {
    const assets = await api.get<Asset[]>(`/api/projects/${projectId}/assets`)
    set({ assets })
  },

  async generateVoice (projectId) {
    set({ voiceBusy: true, voiceSegmentCount: null, error: null })
    try {
      const r = await api.post<VoiceResult>(`/api/projects/${projectId}/voice`)
      set({ voiceSegmentCount: r.segmentCount })
      await get().loadAssets(projectId)
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '配音失败' })
    } finally {
      set({ voiceBusy: false })
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
