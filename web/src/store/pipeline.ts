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

interface PipelineState {
  assets: Asset[]
  job: JobState | null
  uploading: boolean
  voiceBusy: boolean
  error: string | null
  loadAssets: (projectId: string) => Promise<void>
  upload: (projectId: string, file: File, kind: 'video' | 'bgm') => Promise<void>
  removeAsset: (assetId: string, projectId: string) => Promise<void>
  generateVoice: (projectId: string) => Promise<void>
  startExport: (projectId: string) => Promise<void>
  reset: () => void
}

export const usePipeline = create<PipelineState>((set, get) => ({
  assets: [], job: null, uploading: false, voiceBusy: false, error: null,

  reset () { set({ assets: [], job: null, error: null }) },

  async loadAssets (projectId) {
    const assets = await api.get<Asset[]>(`/api/projects/${projectId}/assets`)
    set({ assets })
  },

  async upload (projectId, file, kind) {
    set({ uploading: true, error: null })
    try {
      const form = new FormData()
      form.append('file', file)
      // FormData 不能走 api 客户端的 JSON 封装，这里直接 fetch
      const res = await fetch(`/api/projects/${projectId}/assets?kind=${kind}`, {
        method: 'POST', body: form, credentials: 'include',
      })
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error ?? '上传失败'
        throw new Error(msg)
      }
      await get().loadAssets(projectId)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '上传失败' })
    } finally {
      set({ uploading: false })
    }
  },

  async removeAsset (assetId, projectId) {
    await api.del(`/api/assets/${assetId}`)
    await get().loadAssets(projectId)
  },

  async generateVoice (projectId) {
    set({ voiceBusy: true, error: null })
    try {
      await api.post(`/api/projects/${projectId}/voice`)
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
