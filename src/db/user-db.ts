import Database from 'better-sqlite3'
import { DEFAULT_WATERMARK } from '../subtitles/watermark.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { userDbDir } from '../auth/whitelist.js'
import { DEFAULT_SUBTITLE_MARGIN_V, DEFAULT_SUBTITLE_FONT_SIZE } from '../subtitles/ass.js'
import { LEGACY_VOICE, DEFAULT_VOICE, DEFAULT_VOICE_RATE, DEFAULT_VOICE_PITCH, RATE_RANGE, VOLUME_RANGE, PITCH_RANGE } from '../tts/voices.js'
import { DEFAULT_VOICE_GAIN } from '../audio/analyze.js'

/**
 * 素材种类。
 *
 * - `video` / `bgm`：老项目里用户传过的背景视频与背景音乐（新前端已不再产生）
 * - `voice`：配音音频。既可能是 Azure 生成的（src/tts/routes.ts），
 *   也可能是用户自己传上来的（自备配音）——下游一视同仁
 * - `srt`：用户自备的整句字幕文件。**不是媒体文件**，不要对它跑 ffprobe
 * - `bgtrack`：系统按三段式公式提前拼好的无声背景轨（src/compose/prebuild.ts）。
 *   **永不接受上传**，和 `export` 一样是产物。存成素材是为了让预览能通过
 *   现成的 `/api/assets/<id>`（带 Range）播它，不必再开一条专用的流接口
 * - `export`：系统产出的成片，永不接受上传
 */
/**
 * 背景音乐的默认音量（相对配音）。
 *
 * 15%：配音必须始终压过 BGM，营销号的信息全在人声里。10% 试下来偏轻，
 * 20% 开始抢话。这个值只作用于【新建】项目——已有项目存的是自己的值，
 * ALTER TABLE 的 DEFAULT 只影响新行，不会回头改动任何一条既有数据。
 */
export const DEFAULT_BGM_VOLUME = 0.15

export type AssetKind = 'video' | 'bgm' | 'voice' | 'srt' | 'bgtrack' | 'export'
/**
 * 作业状态。
 *
 * ⚠️【blocked_disk 不是失败】。磁盘腾不出来时合成会停在这一档，等用户
 * 下载走一条片子腾出空间之后【自动继续】——不该让他手动重试。
 * 复用 error 的话，界面会给他一个"重试"按钮，而重试一万次也还是不够。
 */
export type JobStatus =
  'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'blocked_disk'
export type TtsState = 'none' | 'generating' | 'ready' | 'stale' | 'error'

export interface Asset {
  id: string
  projectId: string
  kind: AssetKind
  path: string
  originalName: string
  size: number
  durationMs: number | null
  width: number | null
  height: number | null
  createdAt: string
}

export interface ExportJob {
  id: string
  projectId: string
  status: JobStatus
  progress: number
  error: string | null
  outputPath: string | null
  createdAt: string
}

/** 一个项目。核心是 scriptText——设计文档：项目的核心是文字 */
export interface Project {
  id: string
  name: string
  scriptText: string
  aspectRatio: string
  /** 配音状态。设计文档第 6 节：改文案后置为 stale，提示需重新生成 */
  ttsState: TtsState
  ttsDurationMs: number | null
  /** WordTiming[] 的 JSON。字幕行是推导数据不入库，但词级时间戳要存 */
  wordTimingsJson: string | null
  /** BGM 相对配音的混音音量（0..1） */
  bgmVolume: number
  /**
   * 选中的素材库 BGM 的 id（library_items.id）。null = 不混 BGM。
   *
   * 【只存 id，绝不复制文件】——素材库是全局公用的，导出时按 id 查出
   * 桶名+文件名再拼路径。
   */
  bgmLibraryId: string | null
  subtitleMode: 'line' | 'karaoke'
  /**
   * 字幕距底边的像素数（ASS 的 MarginV，配合 Alignment=2 底部居中）。
   *
   * 不同背景素材主体位置不同，字幕压在人脸上还是压在下方空白，观感差很多。
   * 默认 DEFAULT_SUBTITLE_MARGIN_V = 原来写死在样式行里的值。
   * **钳位在路由层做**（0..画面高度的一半），库里存的是已经钳好的值。
   */
  subtitleMarginV: number
  /** 正文字幕字号，ASS 单位 */
  subtitleFontSize: number
  /**
   * 封面标题——插在成片最前面那两帧上的字。
   * 空串 = 用项目名（老项目一律如此，见 coverTitleOf）。
   */
  coverTitle: string
  /**
   * 动态水印文字。空串 = 不打水印。
   *
   * 【新项目默认打】：做水印那次没定默认值，于是新建的项目一律是空的、
   * 水印那套代码等于没生效——用户问"水印呢"的时候才发现。
   * 老项目仍然是空（ALTER TABLE 的默认值是空串），指纹不变、不会被重烧。
   * 位置/时间表是固定的六角轮转，见 subtitles/watermark.ts。
   */
  watermarkText: string
  /**
   * 作者亲手挑的开头素材，有序的素材 id 数组（JSON）。空串 = 没挑，走默认随机排布。
   *
   * 【为什么必须落库】：排布本来是每次现算的（拿项目 id 当随机种子洗牌），
   * 所以往库里扫进新素材，已有项目的排布就会跟着变——这在
   * library/background.ts 里是写明了的已知取舍。人挑过的开头不能这样飘，
   * 存下来才保证重烧一次还是那几段。
   */
  openingPickJson: string
  /**
   * 字幕的语义断点，JSON：{"行文本":[断点下标,…]}。空 = 还没算过/算不出来。
   *
   * 【为什么按行文本索引而不是按行号】：行号会随字幕上限、隐藏标点这些
   * 设置变来变去，存下来第二天就对不上了；而"这一行的字"是稳定的。
   */
  subtitleCutsJson: string
  /**
   * 分集那一屏的【草稿】：{"breakIndex":186,"introEnd":5}。空 = 还没动过。
   *
   * 【为什么要存】：断点和引子是滚轮选出来的，选一半接个电话、切个 app，
   * 回来全没了——而这一屏本来就要读几百句、慢慢比对。状态存住，
   * "随时能离开"才不是个陷阱。
   */
  splitDraftJson: string
  /**
   * 配音在混音时的增益，1 = 原样。
   *
   * ⚠️ 和 voiceVolume 不是一回事：那个是 Azure 合成时的参数（改了要重新
   * 合成、重新计费），这个是混音时的增益（改了只要几秒重混）。
   * 用户拖的滑块拖的是这个。
   */
  voiceGain: number
  /**
   * 两条音轨的体检报告（波形 + 响度），JSON。
   * {"voice":{lufs,truePeak,peaks[],durationMs},"bgm":{...,"libraryId":"..."}}
   *
   * 【预先算好】：配音一完成、音乐一选中就算，用户点进音频那一屏时数据
   * 已经在了。10 分钟的音频让手机现解码画波形会卡住好几秒，而那一屏
   * 正是要来回拖滑块的地方。
   */
  audioStatsJson: string
  /**
   * 配音参数的【草稿】：{"voiceName":"…","voiceRate":65,…}。空 = 没在改。
   *
   * ⚠️【为什么不直接写进 voice_rate 那几列】：那几列在【母带指纹】里。
   * 用户只是拖了下滑块、还没点重新配音，直接落库会让指纹立刻失效 →
   * 开机补合把这条片子排上队 → 用老配音重烧十几分钟，纯属白烧。
   *
   * 所以草稿单独放：它只负责"下次进来还是我上次调的值"，不影响任何产物。
   * 点「确认」时才把它提交到真正的那几列（那时才该重配音、重烧）。
   */
  voiceDraftJson: string
  /**
   * 最后一次【针对这条项目】的动作时间（ISO）。空 = 从没动过。
   *
   * ⚠️ 和 updatedAt 不是一回事：updatedAt 只在【改了内容】时动，而"打开看了
   * 一眼""播放了一下"也算动过——归档要按后者算，否则用户天天在看的片子
   * 会因为"没改过"被收起来。
   */
  touchedAt: string
  /** 归档时间（ISO）。空 = 没归档。归档 = 删掉可重算的大文件，只留索引/参数/配音 */
  archivedAt: string
  /**
   * 最后一次下载成功的时间（ISO）。空 = 从没下载过。
   * 归档【只收下载过的】——没下载过说明还在打磨，收走等于帮倒忙。
   */
  downloadedAt: string
  /**
   * 开头是否还等着人挑。'pending' = 挡住自动排队，'settled' = 放行。
   *
   * 【默认必须是 settled】：迁移默认值会回填进所有老行，填 pending 的话
   * 十几条历史项目会集体变成"等人挑开头"，开机补合再也合不出东西来。
   */
  openingState: 'pending' | 'settled'
  /**
   * 片内标题——顶部常驻那行大字。空串 = 用项目名。
   * 【和封面标题是两个东西】：封面是给平台抓缩略图看的，片内是看片的人
   * 全程都在看的那行，作者会想给它们写不一样的话。
   */
  inVideoTitle: string
  /** 续集指向它的主片；主片自己是 null。两条片子的关联全靠它 */
  parentProjectId: string | null
  /** 第几集。主片 1，续集 2。列表按它在母文件夹下排序 */
  episodeIndex: number
  /** 配音音色/语速/音量/音调。只对文本配音路有意义，见 tts/voices.ts */
  voiceName: string
  voiceRate: number
  voiceVolume: number
  voicePitch: number
  /**
   * 人名谐音替换（只对文本项目有意义）。
   * renameEnabled：是否走"去章节+改名"链（新文本项目默认开；老项目迁移默认关，
   *   不打扰它们）。renameState：none/analyzing/proposed/confirmed——未 confirmed
   *   且 enabled 的文本项目会挡住配音（见 tts 路由的阻拦）。
   * renameAnalysisJson：API-1 草案 + 关系图。renameMapJson：确认/编辑后要执行的映射。
   */
  renameEnabled: boolean
  renameState: 'none' | 'analyzing' | 'proposed' | 'confirmed'
  renameAnalysisJson: string | null
  renameMapJson: string | null
  /**
   * 【开头段的边界】，毫秒。**配音完成那一刻算好写死，之后永不改。**
   *
   * 为「重选开头」服务：只要这个分界永远落在同一时刻，后半段就能原样复用，
   * 重选开头时只重烧那一两分钟，而不是整条 14 分钟。
   *
   * ⚠️【null 是有意义的值，不是"还没算"】：
   *   · null = 老项目 / 还没配音 / 算不出边界 → 走原来的排布逻辑，
   *            **不支持重选开头**
   *   · 有值 = 开头桶必须正好铺满到这里，不允许缺口顺延
   *
   * 这个区分就是【隔离】本身：改填充规则会让排布变、母带指纹跟着变，
   * 老项目会被开机补合全部重烧。靠这一列把新旧两套逻辑分开，老项目
   * 逐字节不变。和"字幕上限 17→14 用 LEGACY_SUBTITLE_MAX_CHARS 隔离"
   * 是同一个套路。
   *
   * ⚠️【必须落库，不能每次现算】。比例常数以后可能会调，现算的话老项目的
   * 边界会跟着漂，盘上那份后半段就对不上新时间轴了。一次算定，终身有效。
   */
  headBoundaryMs: number | null
  createdAt: string
  updatedAt: string
}

export interface UserDb {
  raw: Database.Database
  path: string
  listProjects (): Project[]
  getProject (id: string): Project | null
  createProject (name: string): Project
  updateProject (id: string, patch: {
    name?: string; scriptText?: string; aspectRatio?: string
    ttsState?: TtsState; ttsDurationMs?: number | null; wordTimingsJson?: string | null
    bgmVolume?: number; subtitleMode?: 'line' | 'karaoke'
    bgmLibraryId?: string | null
    subtitleMarginV?: number
    subtitleFontSize?: number
    coverTitle?: string
    watermarkText?: string
    openingPickJson?: string
    subtitleCutsJson?: string
    splitDraftJson?: string
    voiceGain?: number
    audioStatsJson?: string
    voiceDraftJson?: string
    touchedAt?: string
    archivedAt?: string
    downloadedAt?: string
    openingState?: 'pending' | 'settled'
    inVideoTitle?: string
    parentProjectId?: string | null
    episodeIndex?: number
    voiceName?: string; voiceRate?: number; voiceVolume?: number; voicePitch?: number
    renameEnabled?: boolean
    renameState?: 'none' | 'analyzing' | 'proposed' | 'confirmed'
    renameAnalysisJson?: string | null
    renameMapJson?: string | null
    headBoundaryMs?: number | null
  }): Project | null
  deleteProject (id: string): boolean
  addAsset (input: {
    projectId: string; kind: AssetKind; path: string; originalName: string
    size: number; durationMs?: number; width?: number; height?: number
  }): Asset
  listAssets (projectId: string, kind?: AssetKind): Asset[]
  /** 就地改一条素材。⚠️ 用它而不是删了重插——见 prebuild.ts 对 id 稳定性的说明 */
  updateAsset (id: string, patch: { path?: string; durationMs?: number | null }): Asset | null
  getAsset (id: string): Asset | null
  deleteAsset (id: string): boolean
  createJob (projectId: string): ExportJob
  updateJob (id: string, patch: { status?: JobStatus; progress?: number; error?: string; outputPath?: string }): ExportJob | null
  getJob (id: string): ExportJob | null
  latestJob (projectId: string): ExportJob | null
  /**
   * 用户级别的偏好，key → JSON 串。目前只有音频配置（audio）。
   *
   * 【和项目字段的区别】：项目字段是"这条片子用什么"，偏好是"我习惯用什么"。
   * 偏好【不会自动套到任何项目上】——用户在音频面板点「应用」才生效。
   * 自动套的话，他改一条片子的音量会莫名其妙影响到别的，那是最难查的一类怪事。
   */
  getSetting (key: string): string | null
  setSetting (key: string, value: string): void
  close (): void
}

/** SQLite 行 → Project（列名 snake_case，对外 camelCase） */
interface Row {
  id: string; name: string; script_text: string; aspect_ratio: string
  tts_state: string; tts_duration_ms: number | null; word_timings_json: string | null
  bgm_volume: number; subtitle_mode: string; bgm_library_id: string | null
  subtitle_margin_v: number | null
  subtitle_font_size: number | null
  cover_title: string | null
  watermark_text: string | null
  opening_pick_json: string | null
  subtitle_cuts_json: string | null
  split_draft_json: string | null
  voice_gain: number | null
  audio_stats_json: string | null
  voice_draft_json: string | null
  touched_at: string | null
  archived_at: string | null
  downloaded_at: string | null
  opening_state: string | null
  in_video_title: string | null
  parent_project_id: string | null
  episode_index: number | null
  voice_name: string | null
  voice_rate: number | null
  voice_volume: number | null
  voice_pitch: number | null
  rename_enabled: number | null
  rename_state: string | null
  rename_analysis_json: string | null
  rename_map_json: string | null
  head_boundary_ms: number | null
  created_at: string; updated_at: string
}
const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, scriptText: r.script_text, aspectRatio: r.aspect_ratio,
  ttsState: (r.tts_state ?? 'none') as TtsState,
  ttsDurationMs: r.tts_duration_ms,
  wordTimingsJson: r.word_timings_json,
  bgmVolume: r.bgm_volume ?? DEFAULT_BGM_VOLUME,
  bgmLibraryId: r.bgm_library_id ?? null,
  subtitleMode: (r.subtitle_mode ?? 'karaoke') as 'line' | 'karaoke',
  subtitleMarginV: r.subtitle_margin_v ?? DEFAULT_SUBTITLE_MARGIN_V,
  subtitleFontSize: r.subtitle_font_size ?? DEFAULT_SUBTITLE_FONT_SIZE,
  coverTitle: r.cover_title ?? '',
  watermarkText: r.watermark_text ?? '',
  openingPickJson: r.opening_pick_json ?? '',
  subtitleCutsJson: r.subtitle_cuts_json ?? '',
  splitDraftJson: r.split_draft_json ?? '',
  voiceGain: r.voice_gain ?? 1,
  audioStatsJson: r.audio_stats_json ?? '',
  voiceDraftJson: r.voice_draft_json ?? '',
  touchedAt: r.touched_at ?? '',
  archivedAt: r.archived_at ?? '',
  downloadedAt: r.downloaded_at ?? '',
  openingState: r.opening_state === 'pending' ? 'pending' : 'settled',
  inVideoTitle: r.in_video_title ?? '',
  parentProjectId: r.parent_project_id ?? null,
  episodeIndex: r.episode_index ?? 1,
  // 老行没有这几列时回落到「老默认」——晓晓+中性，正是它们的事实值
  voiceName: r.voice_name ?? LEGACY_VOICE,
  voiceRate: r.voice_rate ?? RATE_RANGE.default,
  voiceVolume: r.voice_volume ?? VOLUME_RANGE.default,
  voicePitch: r.voice_pitch ?? PITCH_RANGE.default,
  // 老行没有这几列时：改名关、none（老项目一律不进改名链，不被打扰）
  renameEnabled: (r.rename_enabled ?? 0) === 1,
  renameState: (r.rename_state ?? 'none') as 'none' | 'analyzing' | 'proposed' | 'confirmed',
  renameAnalysisJson: r.rename_analysis_json ?? null,
  renameMapJson: r.rename_map_json ?? null,
  // 老行没有这列 → null：走原排布逻辑，不支持重选开头
  headBoundaryMs: r.head_boundary_ms ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

const toAsset = (r: Record<string, unknown>): Asset => ({
  id: r.id as string, projectId: r.project_id as string, kind: r.kind as AssetKind,
  path: r.path as string, originalName: r.original_name as string, size: r.size as number,
  durationMs: (r.duration_ms as number) ?? null, width: (r.width as number) ?? null,
  height: (r.height as number) ?? null, createdAt: r.created_at as string,
})

const toJob = (r: Record<string, unknown>): ExportJob => ({
  id: r.id as string, projectId: r.project_id as string, status: r.status as JobStatus,
  progress: r.progress as number, error: (r.error as string) ?? null,
  outputPath: (r.output_path as string) ?? null, createdAt: r.created_at as string,
})

/**
 * 打开某用户的独立数据库。
 *
 * ⚠️ 物理隔离的核心：函数签名【只收 name + 白名单】，绝不收 path。
 * 打开哪个文件由 userDbDir(name) 经白名单映射唯一确定，外部无法注入路径。
 * 这就是为什么整个项目里【不存在 WHERE owner = ?】——打开的库本身就是那个人的。
 */
export function openUserDb (name: string, whitelist: string[]): UserDb {
  const dir = userDbDir(name, whitelist)   // 先过白名单，防路径穿越
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'app.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      script_text TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '9:16',
      tts_state TEXT NOT NULL DEFAULT 'none',
      tts_duration_ms INTEGER,
      word_timings_json TEXT,
      bgm_volume REAL NOT NULL DEFAULT 0.15,
      subtitle_mode TEXT NOT NULL DEFAULT 'karaoke',
      bgm_library_id TEXT,
      subtitle_margin_v INTEGER NOT NULL DEFAULT ${DEFAULT_SUBTITLE_MARGIN_V},
      subtitle_font_size INTEGER NOT NULL DEFAULT ${DEFAULT_SUBTITLE_FONT_SIZE},
      cover_title TEXT NOT NULL DEFAULT '',
      watermark_text TEXT NOT NULL DEFAULT '',
      opening_pick_json TEXT NOT NULL DEFAULT '',
      subtitle_cuts_json TEXT NOT NULL DEFAULT '',
      split_draft_json TEXT NOT NULL DEFAULT '',
      voice_gain REAL NOT NULL DEFAULT 2.19,
      audio_stats_json TEXT NOT NULL DEFAULT '',
      voice_draft_json TEXT NOT NULL DEFAULT '',
      touched_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      downloaded_at TEXT NOT NULL DEFAULT '',
      opening_state TEXT NOT NULL DEFAULT 'settled',
      in_video_title TEXT NOT NULL DEFAULT '',
      parent_project_id TEXT,
      episode_index INTEGER NOT NULL DEFAULT 1,
      voice_name TEXT NOT NULL DEFAULT '${LEGACY_VOICE}',
      voice_rate INTEGER NOT NULL DEFAULT ${RATE_RANGE.default},
      voice_volume INTEGER NOT NULL DEFAULT ${VOLUME_RANGE.default},
      voice_pitch INTEGER NOT NULL DEFAULT ${PITCH_RANGE.default},
      rename_enabled INTEGER NOT NULL DEFAULT 0,
      rename_state TEXT NOT NULL DEFAULT 'none',
      rename_analysis_json TEXT,
      rename_map_json TEXT,
      head_boundary_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration_ms INTEGER,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL
    );
    /*
     * 用户级设置。**故意做成 key/value 而不是一张宽表**：这里放的是
     * "我习惯把字幕摆多高"这类个人偏好，加一项就多一个键，不用改表结构、
     * 不用写迁移。项目自己的字段（每条片子各不相同）仍然在 projects 上，
     * 两者别混——偏好只在【新建项目那一刻】被读一次当初值。
     */
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      output_path TEXT,
      created_at TEXT NOT NULL
    );
  `)

  // 已存在的旧库要补列（阶段 3A 建的 projects 表没有这几列）
  const cols = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name)
  const addCol = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`)
  }
  addCol('tts_state', "tts_state TEXT NOT NULL DEFAULT 'none'")
  addCol('tts_duration_ms', 'tts_duration_ms INTEGER')
  addCol('word_timings_json', 'word_timings_json TEXT')
  addCol('bgm_volume', 'bgm_volume REAL NOT NULL DEFAULT 0.15')
  addCol('subtitle_mode', "subtitle_mode TEXT NOT NULL DEFAULT 'karaoke'")
  // 素材库驱动的 BGM 选择。【必须走这条增量迁移】：上面的
  // CREATE TABLE IF NOT EXISTS 对已存在的 projects 表一行都不改，
  // 真实用户的库里这一列只能靠 ALTER TABLE 补上。
  addCol('bgm_library_id', 'bgm_library_id TEXT')
  // 字幕纵向位置。同样【必须走这条增量迁移】——线上库里 projects 表早就
  // 建好了，光改上面的 CREATE 语句，真实用户的库永远不会有这一列。
  // NOT NULL DEFAULT 会把默认值回填进所有既有行，而这个默认值正是原来
  // 写死在 Sub 样式行里的那个数，所以老项目的观感一动不动。
  addCol('subtitle_margin_v', `subtitle_margin_v INTEGER NOT NULL DEFAULT ${DEFAULT_SUBTITLE_MARGIN_V}`)
  addCol('subtitle_font_size', `subtitle_font_size INTEGER NOT NULL DEFAULT ${DEFAULT_SUBTITLE_FONT_SIZE}`)
  /*
   * 【默认空串而不是项目名】。ALTER TABLE 的默认值会回填进所有老行，
   * 填不进"每行各自的项目名"；而空串的语义正好就是"用项目名"，
   * 于是老项目自动拿到以项目名为标题的封面，一行迁移代码都不用写。
   */
  addCol('cover_title', "cover_title TEXT NOT NULL DEFAULT ''")
  /*
   * 水印默认【空串 = 不打】。和 cover_title 那次的理由正好相反：空串在这里
   * 不是"跟着项目名走"，而是"这个项目没有水印"。默认必须是不打——
   * ALTER TABLE 的默认值会回填进所有老行，填个非空值等于给十几条历史项目
   * 凭空加上水印，它们的指纹随即失效、全部重烧。
   */
  addCol('watermark_text', "watermark_text TEXT NOT NULL DEFAULT ''")
  addCol('opening_pick_json', "opening_pick_json TEXT NOT NULL DEFAULT ''")
  addCol('subtitle_cuts_json', "subtitle_cuts_json TEXT NOT NULL DEFAULT ''")
  addCol('split_draft_json', "split_draft_json TEXT NOT NULL DEFAULT ''")
  addCol('voice_gain', 'voice_gain REAL NOT NULL DEFAULT 1')
  addCol('audio_stats_json', "audio_stats_json TEXT NOT NULL DEFAULT ''")
  addCol('voice_draft_json', "voice_draft_json TEXT NOT NULL DEFAULT ''")
  addCol('touched_at', "touched_at TEXT NOT NULL DEFAULT ''")
  addCol('archived_at', "archived_at TEXT NOT NULL DEFAULT ''")
  addCol('downloaded_at', "downloaded_at TEXT NOT NULL DEFAULT ''")
  /* settled 是老项目的事实：它们从来没有"等人挑开头"这回事 */
  addCol('opening_state', "opening_state TEXT NOT NULL DEFAULT 'settled'")
  addCol('in_video_title', "in_video_title TEXT NOT NULL DEFAULT ''")
  /*
   * parent_project_id 【不能】NOT NULL——老项目全是独立的主片，null 就是
   * "我没有上一集"这个事实本身。给它填个空串当默认值只会让"没有上一集"
   * 和"上一集的 id 是空串"混成一件事。
   */
  addCol('parent_project_id', 'parent_project_id TEXT')
  addCol('episode_index', 'episode_index INTEGER NOT NULL DEFAULT 1')
  // ⚠️ 配音列的默认值填【老默认晓晓】不是晓辰：ALTER TABLE 会把这个默认回填进
  // 所有老行，回填成晓晓才是它们的事实，母带指纹才不变、才不会被重烧。
  // 新项目的晓辰由 createProject 显式写（见下）。
  addCol('voice_name', `voice_name TEXT NOT NULL DEFAULT '${LEGACY_VOICE}'`)
  addCol('voice_rate', `voice_rate INTEGER NOT NULL DEFAULT ${RATE_RANGE.default}`)
  addCol('voice_volume', `voice_volume INTEGER NOT NULL DEFAULT ${VOLUME_RANGE.default}`)
  addCol('voice_pitch', `voice_pitch INTEGER NOT NULL DEFAULT ${PITCH_RANGE.default}`)
  // 改名相关。默认【关 + none】回填老行——老项目不进改名链、不被阻拦、
  // 指纹和成片一动不动；新项目的"默认开"由 createProject 显式写（见下）。
  addCol('rename_enabled', 'rename_enabled INTEGER NOT NULL DEFAULT 0')
  addCol('rename_state', "rename_state TEXT NOT NULL DEFAULT 'none'")
  addCol('rename_analysis_json', 'rename_analysis_json TEXT')
  addCol('rename_map_json', 'rename_map_json TEXT')
  /*
   * ⚠️【可空，且【不给】默认值】。老项目补出来就是 NULL，正好落在
   * "走原逻辑、不支持重选开头"那一档——这就是隔离本身。
   * 给了默认值的话所有老项目会当场变成"支持"，排布跟着变，全部重烧。
   */
  addCol('head_boundary_ms', 'head_boundary_ms INTEGER')

  return {
    raw: db,
    path,

    listProjects () {
      const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]
      return rows.map(toProject)
    },

    getProject (id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      return row ? toProject(row) : null
    },

    createProject (projectName) {
      const now = new Date().toISOString()
      const project: Project = {
        id: randomUUID(), name: projectName, scriptText: '',
        aspectRatio: '9:16', ttsState: 'none', ttsDurationMs: null,
        wordTimingsJson: null, bgmVolume: DEFAULT_BGM_VOLUME, subtitleMode: 'karaoke',
        bgmLibraryId: null, subtitleMarginV: DEFAULT_SUBTITLE_MARGIN_V,
        subtitleFontSize: DEFAULT_SUBTITLE_FONT_SIZE,
        coverTitle: '',      // 空 = 跟着项目名走
        watermarkText: DEFAULT_WATERMARK,
        openingPickJson: '', // 空 = 用默认随机排布
        subtitleCutsJson: '', // 空 = 还没算语义断点
        splitDraftJson: '',   // 空 = 分集那一屏还没动过
        /*
         * 【默认就给推荐值，不再让用户自己摸索】。
         *
         * Azure 的配音响度稳定在 -20.8 LUFS 附近（实测两条长度差 90 倍的
         * 配音只差 0.9 LU），所以"推到平台惯用的 -14"是个算得出来的定值。
         * 以前默认 1（原样）时，两个真实用户分别拖到了 2.09 和 3.17——
         * 而他们的原始配音只差 0.9 LU，那不是在补偿素材差异，是各自凭感觉
         * 找了半天。其中一条拖到的 2.09，和按他那条配音算出来的推荐值
         * 【一模一样】——说明这个公式给的就是人耳想要的那个数。
         *
         * ⚠️【只影响新项目】。老项目的 voice_gain 早就落库了，这里碰不到，
         * 而且配音增益不进母带指纹（母带无声，增益只在下载现混时起作用），
         * 所以改它不会让任何一条老片子重烧。
         */
        voiceGain: DEFAULT_VOICE_GAIN,
        audioStatsJson: '',   // 空 = 还没量过
        voiceDraftJson: '',   // 空 = 配音参数没在改
        touchedAt: now,       // 刚建出来就算动过
        archivedAt: '',       // 没归档
        downloadedAt: '',     // 没下载过
        openingState: 'settled',  // 走新建项目那条线时才由路由改成 pending
        inVideoTitle: '',    // 同上
        parentProjectId: null,
        episodeIndex: 1,
        voiceName: DEFAULT_VOICE, voiceRate: DEFAULT_VOICE_RATE,
        voiceVolume: VOLUME_RANGE.default, voicePitch: DEFAULT_VOICE_PITCH,
        // 新项目默认走文本(karaoke)，改名默认开；自备路 adopt 时会关掉/不适用
        renameEnabled: true, renameState: 'none',
        renameAnalysisJson: null, renameMapJson: null,
        headBoundaryMs: null,   // 配音完成那一刻才算得出来
        createdAt: now, updatedAt: now,
      }
      db.prepare(
        `INSERT INTO projects
          (id, name, script_text, aspect_ratio, tts_state, tts_duration_ms, word_timings_json, bgm_volume, subtitle_mode, bgm_library_id, subtitle_margin_v, subtitle_font_size, cover_title, watermark_text, opening_pick_json, opening_state, subtitle_cuts_json, split_draft_json, voice_gain, audio_stats_json, voice_draft_json, touched_at, archived_at, downloaded_at, in_video_title, parent_project_id, episode_index, voice_name, voice_rate, voice_volume, voice_pitch, rename_enabled, rename_state, rename_analysis_json, rename_map_json, head_boundary_ms, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.id, project.name, project.scriptText, project.aspectRatio,
        project.ttsState, project.ttsDurationMs, project.wordTimingsJson,
        project.bgmVolume, project.subtitleMode, project.bgmLibraryId,
        project.subtitleMarginV, project.subtitleFontSize, project.coverTitle,
        project.watermarkText, project.openingPickJson, project.openingState,
        project.subtitleCutsJson, project.splitDraftJson, project.voiceGain,
        project.audioStatsJson, project.voiceDraftJson,
        project.touchedAt, project.archivedAt, project.downloadedAt, project.inVideoTitle, project.parentProjectId, project.episodeIndex,
        project.voiceName, project.voiceRate, project.voiceVolume, project.voicePitch,
        project.renameEnabled ? 1 : 0, project.renameState,
        project.renameAnalysisJson, project.renameMapJson, project.headBoundaryMs,
        now, now,
      )
      return project
    },

    updateProject (id, patch) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      if (!row) return null
      const now = new Date().toISOString()
      // 部分更新：没传的字段保持原值
      db.prepare(
        `UPDATE projects SET
          name = ?, script_text = ?, aspect_ratio = ?,
          tts_state = ?, tts_duration_ms = ?, word_timings_json = ?,
          bgm_volume = ?, subtitle_mode = ?, bgm_library_id = ?,
          subtitle_margin_v = ?, subtitle_font_size = ?, cover_title = ?,
          watermark_text = ?, opening_pick_json = ?, opening_state = ?,
          subtitle_cuts_json = ?, split_draft_json = ?, voice_gain = ?,
          audio_stats_json = ?, voice_draft_json = ?,
          touched_at = ?, archived_at = ?, downloaded_at = ?, in_video_title = ?, parent_project_id = ?, episode_index = ?,
          voice_name = ?, voice_rate = ?, voice_volume = ?, voice_pitch = ?,
          rename_enabled = ?, rename_state = ?, rename_analysis_json = ?, rename_map_json = ?,
          head_boundary_ms = ?,
          updated_at = ?
          WHERE id = ?`
      ).run(
        patch.name ?? row.name,
        patch.scriptText ?? row.script_text,
        patch.aspectRatio ?? row.aspect_ratio,
        patch.ttsState ?? row.tts_state,
        patch.ttsDurationMs !== undefined ? patch.ttsDurationMs : row.tts_duration_ms,
        patch.wordTimingsJson !== undefined ? patch.wordTimingsJson : row.word_timings_json,
        patch.bgmVolume ?? row.bgm_volume,
        patch.subtitleMode ?? row.subtitle_mode,
        // 【必须用 !== undefined 判断】：null 是有意义的值（清空 BGM 选择），
        // 用 ?? 的话永远清不掉
        patch.bgmLibraryId !== undefined ? patch.bgmLibraryId : row.bgm_library_id,
        // 0 是有意义的值（贴着底边），?? 会把它当成"没传"——必须判 undefined。
        // 旧库刚迁移完这一列理论上不会是 null，仍兜一层默认，不让 NULL 落库。
        patch.subtitleMarginV !== undefined
          ? patch.subtitleMarginV
          : row.subtitle_margin_v ?? DEFAULT_SUBTITLE_MARGIN_V,
        patch.subtitleFontSize !== undefined
          ? patch.subtitleFontSize
          : row.subtitle_font_size ?? DEFAULT_SUBTITLE_FONT_SIZE,
        patch.coverTitle !== undefined ? patch.coverTitle : row.cover_title ?? '',
        patch.watermarkText !== undefined ? patch.watermarkText : row.watermark_text ?? '',
        patch.openingPickJson !== undefined ? patch.openingPickJson : row.opening_pick_json ?? '',
        patch.openingState !== undefined ? patch.openingState : row.opening_state ?? 'settled',
        patch.subtitleCutsJson !== undefined ? patch.subtitleCutsJson : row.subtitle_cuts_json ?? '',
        patch.splitDraftJson !== undefined ? patch.splitDraftJson : row.split_draft_json ?? '',
        patch.voiceGain !== undefined ? patch.voiceGain : row.voice_gain ?? 1,
        patch.audioStatsJson !== undefined ? patch.audioStatsJson : row.audio_stats_json ?? '',
        patch.voiceDraftJson !== undefined ? patch.voiceDraftJson : row.voice_draft_json ?? '',
        patch.touchedAt !== undefined ? patch.touchedAt : row.touched_at ?? '',
        patch.archivedAt !== undefined ? patch.archivedAt : row.archived_at ?? '',
        patch.downloadedAt !== undefined ? patch.downloadedAt : row.downloaded_at ?? '',
        patch.inVideoTitle !== undefined ? patch.inVideoTitle : row.in_video_title ?? '',
        patch.parentProjectId !== undefined ? patch.parentProjectId : row.parent_project_id ?? null,
        patch.episodeIndex !== undefined ? patch.episodeIndex : row.episode_index ?? 1,
        patch.voiceName !== undefined ? patch.voiceName : row.voice_name ?? LEGACY_VOICE,
        patch.voiceRate !== undefined ? patch.voiceRate : row.voice_rate ?? RATE_RANGE.default,
        patch.voiceVolume !== undefined ? patch.voiceVolume : row.voice_volume ?? VOLUME_RANGE.default,
        patch.voicePitch !== undefined ? patch.voicePitch : row.voice_pitch ?? PITCH_RANGE.default,
        patch.renameEnabled !== undefined ? (patch.renameEnabled ? 1 : 0) : (row.rename_enabled ?? 0),
        patch.renameState !== undefined ? patch.renameState : (row.rename_state ?? 'none'),
        // null 是有意义的值（清空分析/映射）→ 判 undefined 而非 ??
        patch.renameAnalysisJson !== undefined ? patch.renameAnalysisJson : row.rename_analysis_json,
        patch.renameMapJson !== undefined ? patch.renameMapJson : row.rename_map_json,
        // null 是有意义的值（"不支持重选开头"）→ 判 undefined 而非 ??
        patch.headBoundaryMs !== undefined ? patch.headBoundaryMs : row.head_boundary_ms,
        now, id,
      )
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row
      return toProject(updated)
    },

    deleteProject (id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return info.changes > 0
    },

    addAsset (input) {
      const now = new Date().toISOString()
      const asset: Asset = {
        id: randomUUID(), projectId: input.projectId, kind: input.kind,
        path: input.path, originalName: input.originalName, size: input.size,
        durationMs: input.durationMs ?? null, width: input.width ?? null,
        height: input.height ?? null, createdAt: now,
      }
      db.prepare(`INSERT INTO assets
        (id, project_id, kind, path, original_name, size, duration_ms, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        asset.id, asset.projectId, asset.kind, asset.path, asset.originalName,
        asset.size, asset.durationMs, asset.width, asset.height, now)
      return asset
    },

    updateAsset (id, patch) {
      const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!row) return null
      db.prepare('UPDATE assets SET path = ?, duration_ms = ? WHERE id = ?').run(
        patch.path ?? row['path'],
        patch.durationMs !== undefined ? patch.durationMs : row['duration_ms'],
        id,
      )
      return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown>)
    },

    listAssets (projectId, kind) {
      const rows = kind
        ? db.prepare('SELECT * FROM assets WHERE project_id = ? AND kind = ? ORDER BY created_at').all(projectId, kind)
        : db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at').all(projectId)
      return (rows as Record<string, unknown>[]).map(toAsset)
    },

    getAsset (id) {
      const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
      return row ? toAsset(row as Record<string, unknown>) : null
    },

    deleteAsset (id) {
      return db.prepare('DELETE FROM assets WHERE id = ?').run(id).changes > 0
    },

    createJob (projectId) {
      const now = new Date().toISOString()
      const job: ExportJob = {
        id: randomUUID(), projectId, status: 'queued', progress: 0,
        error: null, outputPath: null, createdAt: now,
      }
      db.prepare('INSERT INTO export_jobs (id, project_id, status, progress, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(job.id, projectId, job.status, job.progress, now)
      return job
    },

    updateJob (id, patch) {
      const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!row) return null
      db.prepare('UPDATE export_jobs SET status = ?, progress = ?, error = ?, output_path = ? WHERE id = ?').run(
        patch.status ?? row.status,
        patch.progress ?? row.progress,
        patch.error ?? row.error ?? null,
        patch.outputPath ?? row.output_path ?? null,
        id)
      return getJob(id)
    },

    getJob (id) {
      return getJob(id)
    },

    latestJob (projectId) {
      const row = db.prepare(
        // 按 rowid 排序：created_at 是毫秒精度的 ISO 串，同毫秒建的两个作业
        // 顺序不确定（实测会随机失败）。rowid 是 SQLite 每张普通表天然自带的
        // 隐藏列，按插入顺序单调递增，且无需 ALTER TABLE 就能用。
        'SELECT * FROM export_jobs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get(projectId)
      return row ? toJob(row as Record<string, unknown>) : null
    },

    getSetting (key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value?: string } | undefined
      return row?.value ?? null
    },

    setSetting (key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value)
    },

    close () { db.close() },
  }

  function getJob (id: string): ExportJob | null {
    const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id)
    return row ? toJob(row as Record<string, unknown>) : null
  }
}
