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
  /** 选中的素材库 BGM 的 id。null = 不要背景音乐，是个有意义的值 */
  bgmLibraryId: string | null
  /** 背景音乐相对配音的音量，0..1。后端一直在用，默认 0.1 */
  bgmVolume: number
  /**
   * 字幕渲染模式，同时也是**时间轴粒度的标记**：
   * `karaoke` = AI 配音的词级时间轴，逐字扫光；
   * `line` = 自备 SRT 的句级时间轴，整句显示（SRT 没有逐字信息）。
   */
  subtitleMode: 'line' | 'karaoke'
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
  /** 素材选择类字段的通用补丁（乐观更新）。setBgm / setBgmVolume 的共用底座 */
  patchProject: (patch: Partial<Pick<Project, 'bgmLibraryId' | 'bgmVolume'>>) => Promise<void>
  /** 选/取消选背景音乐。null 表示不要 BGM */
  setBgm: (bgmLibraryId: string | null) => Promise<void>
  /** 调背景音乐音量。调用方负责节流——见 AssetPanel 的滑块 */
  setBgmVolume: (volume: number) => Promise<void>
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

  /**
   * 素材选择类的补丁。和 updateScript 一样走乐观更新——
   * 点一下 BGM 要立刻选中、拖滑块要跟手，不能等一个来回。
   * 后端回来的整条项目再覆盖一次，以它为准。
   */
  async patchProject (patch: Partial<Pick<Project, 'bgmLibraryId' | 'bgmVolume'>>) {
    const id = get().currentId
    if (!id) return
    set((s) => ({ items: s.items.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
    const updated = await api.patch<Project>(`/api/projects/${id}`, patch)
    set((s) => ({ items: s.items.map((p) => (p.id === id ? updated : p)) }))
  },

  async setBgm (bgmLibraryId) { await get().patchProject({ bgmLibraryId }) },

  async setBgmVolume (volume) {
    // 钳到 0..1：滑块本身给不出越界值，但 store 是公共入口，脏值不该落库
    await get().patchProject({ bgmVolume: Math.min(1, Math.max(0, volume)) })
  },

  async remove (id) {
    await api.del(`/api/projects/${id}`)
    set((s) => {
      const items = s.items.filter((p) => p.id !== id)
      return { items, currentId: s.currentId === id ? items[0]?.id ?? null : s.currentId }
    })
  },
}))
