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
 * 成片的状态。字段与 GET /api/projects/:id/film 一一对应
 * （src/compose/film.ts 的 FilmInfo）——前后端类型不同步是这个项目踩过的坑。
 *
 * ⚠️【成片不是预览播的那个东西】。预览播的是背景轨（无字幕，bgTrack 那套），
 * 成片是字幕烧死 + 混好 BGM 的下载物。两个产物各有各的用途，别把预览的
 * <video> 指过来——那会出现"烧死的字幕 + JASSUB 渲染的字幕"两层重影。
 */
export interface Film {
  state: 'none' | 'building' | 'ready' | 'error'
  jobId: string | null
  progress: number
  /** state=error 时的原因 */
  error: string | null
  /** state=none 时还缺什么 */
  reason: string | null
}

/** 主按钮该长什么样。渲染只管照着画，判断全在这儿，好测。 */
export interface FilmButton {
  label: string
  enabled: boolean
  /** download = 直接下载；retry = 重新合成；none = 现在点不了 */
  action: 'download' | 'retry' | 'none'
  /** 按钮下面那句解释。null = 不用说话 */
  hint: string | null
}

/**
 * ⚠️【「导出视频」已经不存在了】。成片在配音就绪时就由后台自动合成
 * （src/compose/film.ts），用户要做的只剩下载。所以这个按钮永远不叫
 * "导出"——叫导出就等于告诉用户"还有一步要你点"，而那一步已经没有了。
 *
 * 失败时【必须把原因原样说出来】，并且按钮要变成可点的重试。一个只写着
 * "合成失败"、还点不动的按钮，会让用户以为这个项目废了。
 */
export function filmButton (film: Film | null, voiceReady: boolean): FilmButton {
  if (!voiceReady) {
    return {
      label: '下载视频', enabled: false, action: 'none',
      hint: '需要先生成配音——成片的长度由配音决定。',
    }
  }
  switch (film?.state) {
    case 'ready':
      return { label: '下载视频', enabled: true, action: 'download', hint: null }
    case 'building':
      return {
        label: '合成中…', enabled: false, action: 'none',
        hint: '配音已就绪，成片正在后台合成，好了这里就能下载。',
      }
    case 'error':
      return {
        label: '重新合成', enabled: true, action: 'retry',
        hint: film.error ?? '合成失败，点上面的按钮再试一次。',
      }
    case 'none':
      return {
        label: '下载视频', enabled: false, action: 'none',
        hint: film.reason ?? '还不能合成成片。',
      }
    default:
      // 状态还没拉回来的那一瞬间。什么都别说，别闪一句吓人的话
      return { label: '下载视频', enabled: false, action: 'none', hint: null }
  }
}

/**
 * 还要不要接着问成片状态。
 *
 * 只有"在合"才继续问。ready/error/none 都是终态——**none 也是**：
 * 缺的是配音或素材，那两样变了都会改到 project，界面自然会重新触发一轮。
 * 终态还接着轮询等于让两个用户的机器白跑一串请求。
 */
export function shouldPollFilm (film: Film | null): boolean {
  return film === null || film.state === 'building'
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
  /** 成片状态。null = 本次会话还没问过 */
  film: Film | null
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
  /** 问一次成片状态。**永远不抛、永远不置 error** */
  loadFilm: (projectId: string) => Promise<void>
  /** 手动强制重合一遍。用户偶尔需要不问指纹重来 */
  recomposeFilm: (projectId: string) => Promise<void>
  generateVoice: (projectId: string) => Promise<void>
  /** 拖进来的文件 → 上传 → 齐了就派生。返回是否真的派生了 */
  adoptFiles: (projectId: string, files: File[]) => Promise<boolean>
  reset: () => void
}

export const usePipeline = create<PipelineState>((set, get) => ({
  assets: [], bgTrack: null, film: null, voiceBusy: false,
  voiceSegmentCount: null, error: null,
  byoBusy: false, byoHint: null, byoWarning: null, byoScriptFilled: null,

  // 切换项目时清掉：这些都是「本次操作」的结果，跟着项目走会误导
  reset () {
    set({
      assets: [], bgTrack: null, film: null, voiceSegmentCount: null, error: null,
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

  /*
   * 【失败要拉回"未知"，不是"不能合"】。
   *
   * 断网、500、或者后端正在重启时，我们根本不知道成片怎么样。说 error
   * 是在编造一个自己没看见的失败——那条红色是留给真正的合成失败的。
   *
   * ⚠️ 但也【绝不能填成 'none'】。踩过：none 是终态，shouldPollFilm 不再问，
   * 于是一次转瞬即逝的请求失败（比如一次 systemctl restart）会让按钮
   * 永久停在"还不能合成成片"，哪怕后台早就把片子合完了——只有切项目或
   * 刷新页面才能解开。而且那句话是前端瞎编的：后端每条 none 都带着
   * 具体原因，reason 为 null 只可能是这里造出来的。
   *
   * null 表示"还没问出来"，shouldPollFilm(null) 为真，下一轮自己会恢复。
   */
  async loadFilm (projectId) {
    try {
      set({ film: await api.get<Film>(`/api/projects/${projectId}/film`) })
    } catch {
      set({ film: null })
    }
  },

  /**
   * 手动强制重合。
   *
   * 【不是主流程】：成片在配音就绪时就自动开始合了，这个动作只给
   * "我就是想重来一遍"和"上次失败了想重试"用。
   *
   * 乐观地先置成 building，好让按钮立刻变样——否则用户点完要等一整个
   * 轮询周期才看到反应，会以为没点上、然后再点一次，白排一条渲染。
   */
  async recomposeFilm (projectId) {
    set({ error: null, film: { state: 'building', jobId: null, progress: 0, error: null, reason: null } })
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/api/projects/${projectId}/export`)
      set({ film: { state: 'building', jobId, progress: 0, error: null, reason: null } })
    } catch (e) {
      set({
        error: e instanceof ApiError ? e.message : '重新合成失败',
        film: null,   // 拉回未知态，让下一轮轮询问出真相
      })
    }
  },
}))
