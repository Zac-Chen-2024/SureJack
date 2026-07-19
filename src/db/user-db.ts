import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { userDbDir } from '../auth/whitelist.js'
import { DEFAULT_SUBTITLE_MARGIN_V } from '../subtitles/ass.js'

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
export type JobStatus = 'queued' | 'running' | 'done' | 'error'
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
  }): Project | null
  deleteProject (id: string): boolean
  addAsset (input: {
    projectId: string; kind: AssetKind; path: string; originalName: string
    size: number; durationMs?: number; width?: number; height?: number
  }): Asset
  listAssets (projectId: string, kind?: AssetKind): Asset[]
  getAsset (id: string): Asset | null
  deleteAsset (id: string): boolean
  createJob (projectId: string): ExportJob
  updateJob (id: string, patch: { status?: JobStatus; progress?: number; error?: string; outputPath?: string }): ExportJob | null
  getJob (id: string): ExportJob | null
  latestJob (projectId: string): ExportJob | null
  close (): void
}

/** SQLite 行 → Project（列名 snake_case，对外 camelCase） */
interface Row {
  id: string; name: string; script_text: string; aspect_ratio: string
  tts_state: string; tts_duration_ms: number | null; word_timings_json: string | null
  bgm_volume: number; subtitle_mode: string; bgm_library_id: string | null
  subtitle_margin_v: number | null
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
        createdAt: now, updatedAt: now,
      }
      db.prepare(
        `INSERT INTO projects
          (id, name, script_text, aspect_ratio, tts_state, tts_duration_ms, word_timings_json, bgm_volume, subtitle_mode, bgm_library_id, subtitle_margin_v, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.id, project.name, project.scriptText, project.aspectRatio,
        project.ttsState, project.ttsDurationMs, project.wordTimingsJson,
        project.bgmVolume, project.subtitleMode, project.bgmLibraryId,
        project.subtitleMarginV, now, now,
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
          subtitle_margin_v = ?, updated_at = ?
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

    close () { db.close() },
  }

  function getJob (id: string): ExportJob | null {
    const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id)
    return row ? toJob(row as Record<string, unknown>) : null
  }
}
