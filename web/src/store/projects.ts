import { create } from 'zustand'
import { api } from '../api/client'

export interface Project {
  id: string
  name: string
  scriptText: string
  aspectRatio: string
  /** 配音状态。设计文档第 6 节：改文案后置为 stale，提示需重新生成 */
  ttsState: 'none' | 'generating' | 'ready' | 'stale' | 'error'
  ttsDurationMs: number | null
  createdAt: string
  updatedAt: string
}

interface ProjectsState {
  items: Project[]
  currentId: string | null
  loading: boolean
  saving: boolean
  load: () => Promise<void>
  create: (name: string) => Promise<void>
  select: (id: string) => void
  updateScript: (text: string) => Promise<void>
  remove: (id: string) => Promise<void>
  current: () => Project | null
}

export const useProjects = create<ProjectsState>((set, get) => ({
  items: [], currentId: null, loading: false, saving: false,

  current () {
    const { items, currentId } = get()
    return items.find((p) => p.id === currentId) ?? null
  },

  async load () {
    set({ loading: true })
    const items = await api.get<Project[]>('/api/projects')
    set({ loading: false, items, currentId: get().currentId ?? items[0]?.id ?? null })
  },

  async create (name) {
    const p = await api.post<Project>('/api/projects', { name })
    set((s) => ({ items: [p, ...s.items], currentId: p.id }))
  },

  select (id) { set({ currentId: id }) },

  /**
   * 保存文案。乐观更新：先改本地（打字不卡），再发请求。
   * 调用方负责防抖——见 ScriptEditor。
   */
  async updateScript (text) {
    const id = get().currentId
    if (!id) return
    set((s) => ({
      saving: true,
      items: s.items.map((p) => (p.id === id ? { ...p, scriptText: text } : p)),
    }))
    const updated = await api.patch<Project>(`/api/projects/${id}`, { scriptText: text })
    set((s) => ({ saving: false, items: s.items.map((p) => (p.id === id ? updated : p)) }))
  },

  async remove (id) {
    await api.del(`/api/projects/${id}`)
    set((s) => {
      const items = s.items.filter((p) => p.id !== id)
      return { items, currentId: s.currentId === id ? items[0]?.id ?? null : s.currentId }
    })
  },
}))
