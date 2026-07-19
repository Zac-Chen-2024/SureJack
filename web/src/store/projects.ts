import { create } from 'zustand'
import { api } from '../api/client'

/**
 * 字幕距底边的默认像素数。**必须和后端 src/subtitles/ass.ts 的
 * DEFAULT_SUBTITLE_MARGIN_V 相等**——web/ 是独立的 TS 工程，跨目录
 * import 不了后端代码，只能各写一份；tests/web/projects-store.test.ts
 * 里有一条测试把两边钉在一起。
 */
export const DEFAULT_SUBTITLE_MARGIN_V = 300

/**
 * 字幕能贴多低。**必须与后端 src/subtitles/project-ass.ts 的
 * MIN_SUBTITLE_MARGIN_V 相等**——低于这个值字幕会压在免责声明上。
 *
 * 免责声明固定在 MarginV=90、字号 32，占据 90～122；字幕底边就是它的
 * MarginV，160 是在 122 之上再留约 38px 呼吸。
 *
 * 前端设了它，滑块就拖不到后端会悄悄钳回去的位置——那种"松手就弹回"
 * 的手感比直接拖不过去更让人困惑。
 */
export const MIN_SUBTITLE_MARGIN_V = 160

/*
 * 字号的默认值和上下限。⚠️【必须和后端 src/subtitles/ass.ts、
 * project-ass.ts 里的常量保持一致】——前端不能 import 后端（会把
 * better-sqlite3 拖进浏览器包），只能各存一份。对不上的后果是：
 * 滑块能拖到后端会钳掉的值，用户确认后看到的结果和他选的不一样。
 */
export const DEFAULT_SUBTITLE_FONT_SIZE = 64
export const MIN_SUBTITLE_FONT_SIZE = 36
export const MAX_SUBTITLE_FONT_SIZE = 120

/** 和后端 ASPECT_PRESETS 一致。认不出的画幅回落竖屏，与 aspectOf 同规则 */
const ASPECT_HEIGHT: Record<string, number> = {
  '9:16': 1920, '4:5': 1350, '1:1': 1080, '16:9': 1080,
}

/**
 * 滑块上界：画面高度的一半，与后端 clampSubtitleMarginV 同一条规则。
 *
 * ⚠️ 这里算出来的只是【体验】——真正的防线在路由层。滑块给不出越界值，
 * 但接口是公开的，所以后端那一道不能省，这一道也不能自作主张放宽。
 */
export function maxSubtitleMarginV (aspectRatio: string): number {
  return Math.floor((ASPECT_HEIGHT[aspectRatio] ?? 1920) / 2)
}

/**
 * 把像素值说成人话。
 *
 * **故意不显示像素数**：用户关心的是"字幕压不压脸"，不是 120 还是 160。
 * 报一个数字只会让人以为那个数本身有意义，然后开始纠结它。
 */
export function subtitleHeightLabel (value: number, max: number): string {
  const ratio = max > 0 ? value / max : 0
  if (ratio < 0.2) return '贴底'
  if (ratio < 0.45) return '偏下'
  if (ratio < 0.7) return '居中偏下'
  return '偏上'
}

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
  /**
   * 字幕距底边的像素数（ASS 的 MarginV）。改它 → 后端重算 ASS →
   * JASSUB 预览和 ffmpeg 成片一起变，两边读的是同一份文件。
   */
  subtitleMarginV: number
  subtitleFontSize: number
  createdAt: string
  updatedAt: string
}

/**
 * 上次开着哪个项目。存在 localStorage，跨会话有效。
 *
 * ⚠️ 【必须包 try/catch】：隐私模式、禁用 storage、配额满，localStorage
 * 的读写都会抛。为了记住一个项目 id 而让整个工作台白屏，不值得。
 */
const LAST_PROJECT_KEY = 'surejack:last-project'

function loadLastProjectId (): string | null {
  try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null }
}

function saveLastProjectId (id: string): void {
  try { localStorage.setItem(LAST_PROJECT_KEY, id) } catch { /* 记不住就算了 */ }
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
  patchProject: (patch: Partial<Pick<Project, 'bgmLibraryId' | 'bgmVolume' | 'subtitleMarginV' | 'subtitleFontSize'>>) => Promise<void>
  /** 选/取消选背景音乐。null 表示不要 BGM */
  setBgm: (bgmLibraryId: string | null) => Promise<void>
  /** 调背景音乐音量。调用方负责节流——见 AssetPanel 的滑块 */
  setBgmVolume: (volume: number) => Promise<void>
  /** 调字幕高度。调用方负责防抖——见 SubtitleHeight 的滑块 */
  setSubtitleMarginV: (marginV: number) => Promise<void>
  commitSubtitleDraft: () => Promise<void>
  /*
   * 【字幕高度的草稿值】。拖滑块只改它，不落库。
   *
   * 为什么必须有这么个东西：改字幕高度会改 ASS，进而让母带指纹失效——
   * 那是十几分钟的重烧。要是拖一下就落一次库，用户在滑块上来回找位置的
   * 十几秒里能排出十几条渲染，而他其实只想要最后那一个值。
   *
   * 所以拖动期间只有前端在动：滑块改草稿，预览上画一条示意字幕跟着走。
   * 直到用户点「确认」才落库、才真的重烧一次。
   *
   * null = 没有未确认的改动，界面按已存的值显示。
   */
  draftMarginV: number | null
  setDraftMarginV: (marginV: number | null) => void
  /** 字号的草稿值，规则同 draftMarginV */
  draftFontSize: number | null
  setDraftFontSize: (size: number | null) => void
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
    /*
     * 【开着的项目要跨会话记住】。关掉浏览器、服务重启、第二天再来——
     * 回来的应该是上次那个项目，而不是列表里碰巧排第一的那个。
     *
     * 存 localStorage 而不是入库：这是"这台机器上这个人看到哪儿了"，
     * 是本地视图状态，不是项目的属性。存到服务端还会让同一个账号在
     * 两台机器上互相抢位置。
     *
     * 三级兜底：内存里已有的 → 上次记下的（且还存在）→ 第一个。
     * 【必须验证还存在】：记下的项目可能已经被删了，那时候整个工作台
     * 会指着一个不存在的 id，界面一片空白且没有任何提示。
     */
    const remembered = loadLastProjectId()
    const usable = remembered !== null && items.some((p) => p.id === remembered)
      ? remembered
      : null
    set({
      loading: false, items,
      currentId: get().currentId ?? usable ?? items[0]?.id ?? null,
    })
  },

  async create (name) {
    const p = await api.post<Project>('/api/projects', { name })
    set((s) => ({ items: [p, ...s.items], currentId: p.id }))
  },

  // 切项目要清掉草稿——否则上一个项目那个没确认的高度会跟着过来，
  // 界面显示着 A 的改动、确认下去改的却是 B
  select (id) { saveLastProjectId(id); set({ currentId: id, draftMarginV: null, draftFontSize: null }) },

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
  async patchProject (patch: Partial<Pick<Project, 'bgmLibraryId' | 'bgmVolume' | 'subtitleMarginV' | 'subtitleFontSize'>>) {
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

  /**
   * 后端会按画幅把值钳到 0..高度的一半，并把钳好的整条项目回给我们——
   * 乐观更新那一步只是为了跟手，最终以后端为准（updatedAt 也在那时候
   * 变，Preview 靠它重新拉 subtitles.ass，字幕就跟着移动了）。
   */
  draftMarginV: null,
  setDraftMarginV (marginV) { set({ draftMarginV: marginV }) },
  draftFontSize: null,
  setDraftFontSize (size) { set({ draftFontSize: size }) },

  async setSubtitleMarginV (marginV) {
    await get().patchProject({ subtitleMarginV: Math.max(0, Math.round(marginV)) })
  },

  /** 一次把两个草稿值都提交掉。两者都改 ASS，分两次 PATCH 等于排两条渲染 */
  async commitSubtitleDraft () {
    const { draftMarginV, draftFontSize } = get()
    const patch: Partial<Pick<Project, 'subtitleMarginV' | 'subtitleFontSize'>> = {}
    if (draftMarginV !== null) patch.subtitleMarginV = draftMarginV
    if (draftFontSize !== null) patch.subtitleFontSize = draftFontSize
    if (Object.keys(patch).length === 0) return
    await get().patchProject(patch)
    set({ draftMarginV: null, draftFontSize: null })
  },

  async remove (id) {
    await api.del(`/api/projects/${id}`)
    set((s) => {
      const items = s.items.filter((p) => p.id !== id)
      return { items, currentId: s.currentId === id ? items[0]?.id ?? null : s.currentId }
    })
  },
}))
