# SureJack 阶段 3B-1：出片闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在浏览器里完整做出一条视频——传素材、生成配音、点导出、看着进度条走完、下载成片。**不再需要碰命令行。**

**Architecture:** 后端把阶段 1 已验证的管线（TTS → 断句 → ASS → ffmpeg）包成 HTTP 接口 + 进程内串行队列，进度用 SSE 推给前端。前端在工作台右栏加素材与导出面板。**本阶段不做预览和时间轴**——那是 3B-2；先让闭环跑通，能出片的工具就已经有用了。

**Tech Stack:** Fastify + `@fastify/multipart`（上传）、`better-sqlite3`、SSE（原生 `EventSource`）、React + Zustand

## Global Constraints

来自设计文档，逐条照抄，违反即返工：

- **物理隔离**：所有数据走 `openUserDb(name, whitelist)`，素材路径由会话身份拼出。**绝不出现 `WHERE owner = ?`，绝不接受 URL 参数指定文件路径**——"改个 URL 看别人的视频"这条路必须不存在。
- **所有接口挂 `requireAuth`**。
- **配音是手动触发的，不是自动的**：改一个字就重新配音会烧配额、撞限速。流程是「写文案 → 点生成配音 → 拿到音频和时间戳」。改文案后配音标记 `stale`，界面提示需要重新生成。
- **TTS 整篇一次合成，绝不逐句请求**（F0 限速 20 次/60 秒）；提交前用 `estimateAudioMs` 拦截超长文案（含 1.15 保守系数）。
- **背景视频原声一律丢弃**；BGM 音量用一个平衡滑杆。
- **时长由配音决定**：`L > T` 截断，`L < T` 循环。
- **单片段走 `-stream_loop` 快路径；多片段目前显式报错**（两趟渲染未实现，见阶段 1 划界）。
- **ffmpeg 输出必须 `-pix_fmt yuv420p`**，否则部分播放器/平台无法播放。
- **字体族名 `Noto Sans CJK SC`**（写错静默失败）。
- **导出队列串行**，进程内即可（两个用户上分布式队列纯属自残）。
- **SSE 而非 WebSocket**：进度只需服务器单向推，SSE 是这个场景的原生答案。
- **nginx 已配好** `client_max_body_size 500M`、`proxy_buffering off`（SSE 需要）。
- **早失败**：能在提交时发现的问题绝不留到烧钱/等渲染之后（文件不存在、格式不支持、配额耗尽、文案超长）。
- **静默失败最糟糕**：宁可明确报错，绝不返回看似正常的结果。
- 界面遵循已有设计令牌：琥珀金强调色、分层描边、SVG 图标（`Icon.tsx`）、无 emoji。
- Node 24 LTS；后端 127.0.0.1:8809。

---

## 文件结构

```
src/
├── db/user-db.ts             # 修改：加 assets / clips / export_jobs 表 + CRUD
├── assets/
│   ├── storage.ts            # 素材落盘：路径由会话身份拼，防穿越
│   └── routes.ts             # POST /api/projects/:id/assets（上传）、DELETE、GET 列表
├── tts/routes.ts             # POST /api/projects/:id/voice（生成配音）
├── queue/
│   ├── queue.ts              # 进程内串行队列 + 事件发射
│   └── routes.ts             # POST /api/projects/:id/export、GET .../export/stream（SSE）
└── server.ts                 # 修改：注册 multipart + 三组新路由
web/src/
├── store/assets.ts           # 素材状态
├── store/export.ts           # 配音/导出状态 + SSE 订阅
├── components/
│   ├── AssetPanel.tsx        # 右栏：背景视频 / BGM 上传与列表
│   ├── VoicePanel.tsx        # 右栏：生成配音、状态、时长
│   └── ExportPanel.tsx       # 右栏：导出按钮、进度条、下载链接
└── pages/Workspace.tsx       # 修改：右栏装上三个面板
tests/
├── db/user-db-assets.test.ts
├── assets/storage.test.ts
├── queue/queue.test.ts
└── queue/routes.test.ts
```

**为什么这样切**：`storage.ts`（路径安全）和 `queue.ts`（串行调度）是纯逻辑、可单测的核心；路由层薄。前端三个面板各管一件事，互不耦合。

---

## Task 1: 数据模型 —— assets / clips / export_jobs

**Files:**
- Modify: `src/db/user-db.ts`
- Test: `tests/db/user-db-assets.test.ts`

**Interfaces:**
- Consumes: `openUserDb(name, whitelist): UserDb`（已有）
- Produces: 类型 `Asset = { id, projectId, kind, path, originalName, size, durationMs, width, height, createdAt }`（`kind: 'video' | 'bgm' | 'voice' | 'export'`）、`ExportJob = { id, projectId, status, progress, error, outputPath, createdAt }`（`status: 'queued' | 'running' | 'done' | 'error'`）；`UserDb` 新增 `addAsset`、`listAssets`、`getAsset`、`deleteAsset`、`createJob`、`updateJob`、`getJob`、`latestJob`；`Project` 新增字段 `ttsState`、`ttsDurationMs`、`wordTimingsJson`、`bgmVolume`、`subtitleMode`

- [ ] **Step 1: 写失败的测试**

创建 `tests/db/user-db-assets.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试素材甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function fresh (): UserDb {
  const db = openUserDb('测试素材甲', LIST)
  db.raw.exec('DELETE FROM export_jobs; DELETE FROM assets; DELETE FROM projects')
  dbs.push(db)
  return db
}

describe('assets', () => {
  it('新项目没有素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    expect(db.listAssets(p.id)).toEqual([])
  })

  it('加素材后能列出来，字段完整', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const a = db.addAsset({
      projectId: p.id, kind: 'video', path: '/data/x/video.mp4',
      originalName: '素材.mp4', size: 1024, durationMs: 26534, width: 1052, height: 596,
    })
    expect(a.id).toBeTruthy()
    expect(a.kind).toBe('video')
    expect(db.listAssets(p.id)).toHaveLength(1)
  })

  it('按 kind 过滤素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    db.addAsset({ projectId: p.id, kind: 'bgm', path: '/b.mp3', originalName: 'b', size: 1 })
    expect(db.listAssets(p.id, 'video')).toHaveLength(1)
    expect(db.listAssets(p.id, 'bgm')).toHaveLength(1)
  })

  it('删素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const a = db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    expect(db.deleteAsset(a.id)).toBe(true)
    expect(db.listAssets(p.id)).toHaveLength(0)
  })

  it('删项目时它的素材记录也没了（外键级联）', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    db.deleteProject(p.id)
    expect(db.listAssets(p.id)).toHaveLength(0)
  })
})

describe('导出作业', () => {
  it('建作业后是 queued，进度 0', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    expect(job.status).toBe('queued')
    expect(job.progress).toBe(0)
  })

  it('更新进度与状态', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    db.updateJob(job.id, { status: 'running', progress: 42 })
    expect(db.getJob(job.id)?.progress).toBe(42)
    db.updateJob(job.id, { status: 'done', progress: 100, outputPath: '/out.mp4' })
    expect(db.getJob(job.id)?.outputPath).toBe('/out.mp4')
  })

  it('失败的作业记下错误信息', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    db.updateJob(job.id, { status: 'error', error: 'ffmpeg 退出码 1' })
    expect(db.getJob(job.id)?.error).toContain('ffmpeg')
  })

  it('latestJob 取该项目最近一次作业', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.createJob(p.id)
    const second = db.createJob(p.id)
    expect(db.latestJob(p.id)?.id).toBe(second.id)
  })
})

describe('项目的配音状态字段', () => {
  it('新项目 ttsState 是 none', () => {
    const db = fresh()
    expect(db.createProject('项目').ttsState).toBe('none')
  })

  it('能存配音结果并读回', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const updated = db.updateProject(p.id, {
      ttsState: 'ready', ttsDurationMs: 184200,
      wordTimingsJson: JSON.stringify([{ text: '震惊', offsetMs: 50, durationMs: 588, isPunctuation: false }]),
    })
    expect(updated?.ttsState).toBe('ready')
    expect(updated?.ttsDurationMs).toBe(184200)
    expect(JSON.parse(updated!.wordTimingsJson!)).toHaveLength(1)
  })

  it('改文案后配音应被标记 stale —— 由调用方负责，这里验证字段能写', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.updateProject(p.id, { ttsState: 'ready' })
    db.updateProject(p.id, { scriptText: '新文案', ttsState: 'stale' })
    expect(db.getProject(p.id)?.ttsState).toBe('stale')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && npx vitest run tests/db/user-db-assets.test.ts`
Expected: FAIL —— `db.addAsset is not a function`

- [ ] **Step 3: 实现**

修改 `src/db/user-db.ts`。在文件顶部的类型区加：

```typescript
export type AssetKind = 'video' | 'bgm' | 'voice' | 'export'
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
```

`Project` 接口加五个字段：

```typescript
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
  subtitleMode: 'line' | 'karaoke'
  createdAt: string
  updatedAt: string
}
```

`UserDb` 接口加方法：

```typescript
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
```

`updateProject` 的 patch 类型扩展为：

```typescript
  updateProject (id: string, patch: {
    name?: string; scriptText?: string; aspectRatio?: string
    ttsState?: TtsState; ttsDurationMs?: number | null; wordTimingsJson?: string | null
    bgmVolume?: number; subtitleMode?: 'line' | 'karaoke'
  }): Project | null
```

在 `openUserDb` 里，`db.pragma('journal_mode = WAL')` 之后加一行开外键（**级联删除要靠它，SQLite 默认是关的**）：

```typescript
  db.pragma('foreign_keys = ON')
```

建表语句改为（projects 加列 + 两张新表）：

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      script_text TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '9:16',
      tts_state TEXT NOT NULL DEFAULT 'none',
      tts_duration_ms INTEGER,
      word_timings_json TEXT,
      bgm_volume REAL NOT NULL DEFAULT 0.1,
      subtitle_mode TEXT NOT NULL DEFAULT 'karaoke',
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
  addCol('bgm_volume', 'bgm_volume REAL NOT NULL DEFAULT 0.1')
  addCol('subtitle_mode', "subtitle_mode TEXT NOT NULL DEFAULT 'karaoke'")
```

> **为什么要补列**：生产库里已经有真实项目数据（阶段 3A 建的），直接改 CREATE TABLE 对已存在的表无效。不补列就会在读 `tts_state` 时报错——**这是会打挂线上服务的那种失败**。

`toProject` 扩展：

```typescript
interface Row {
  id: string; name: string; script_text: string; aspect_ratio: string
  tts_state: string; tts_duration_ms: number | null; word_timings_json: string | null
  bgm_volume: number; subtitle_mode: string
  created_at: string; updated_at: string
}
const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, scriptText: r.script_text, aspectRatio: r.aspect_ratio,
  ttsState: (r.tts_state ?? 'none') as TtsState,
  ttsDurationMs: r.tts_duration_ms,
  wordTimingsJson: r.word_timings_json,
  bgmVolume: r.bgm_volume ?? 0.1,
  subtitleMode: (r.subtitle_mode ?? 'karaoke') as 'line' | 'karaoke',
  createdAt: r.created_at, updatedAt: r.updated_at,
})
```

`createProject` 的 INSERT 与返回对象补上新字段默认值（`ttsState: 'none'`、`ttsDurationMs: null`、`wordTimingsJson: null`、`bgmVolume: 0.1`、`subtitleMode: 'karaoke'`）。

`updateProject` 的 UPDATE 语句扩展为覆盖新列，仍用 `patch.x ?? row.x` 的部分更新写法。

返回对象里加实现：

```typescript
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
      return this.getJob(id)
    },

    getJob (id) {
      const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id)
      return row ? toJob(row as Record<string, unknown>) : null
    },

    latestJob (projectId) {
      const row = db.prepare('SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId)
      return row ? toJob(row as Record<string, unknown>) : null
    },
```

配套两个行转换器（放在 `toProject` 旁边）：

```typescript
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
```

> **注意**：`updateJob` 里用了 `this.getJob(id)`——返回的是对象字面量，`this` 指向该对象，可用。若 TS 报 `this` 隐式 any，改为把 getJob 提成局部函数再在两处引用。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/db/user-db-assets.test.ts`
Expected: 12 passed

- [ ] **Step 5: 验证旧库能平滑升级（关键——生产库有真实数据）**

```bash
cp -r "data/陈梓昂" /tmp/olddb-backup 2>/dev/null || echo "（无生产数据，跳过）"
npx tsx -e "
import { openUserDb } from './src/db/user-db.js'
import { loadWhitelist } from './src/server.js'
const db = openUserDb('陈梓昂', loadWhitelist())
const ps = db.listProjects()
console.log('旧库项目数:', ps.length)
console.log('第一个项目的 ttsState:', ps[0]?.ttsState)
db.close()
"
```
Expected: 打印出真实项目数和 `ttsState: none`——证明 ALTER TABLE 补列成功、旧数据没坏。

- [ ] **Step 6: 全量回归 + 提交**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（180 + 12 = 192）

```bash
git add src/db/user-db.ts tests/db/user-db-assets.test.ts
git commit -m "feat: 数据模型加 assets / export_jobs / 配音状态字段

projects 补 tts_state/tts_duration_ms/word_timings_json/bgm_volume/subtitle_mode，
用 ALTER TABLE 给已存在的生产库补列——直接改 CREATE TABLE 对已有表无效，
不补列会在读新字段时打挂线上服务。
开 foreign_keys=ON，删项目时素材与作业记录级联清理。"
```

---

## Task 2: 素材存储 —— 路径安全

**Files:**
- Create: `src/assets/storage.ts`
- Test: `tests/assets/storage.test.ts`

**Interfaces:**
- Consumes: `userDbDir(name, whitelist)`（`src/auth/whitelist.ts`）
- Produces: `assetDir(userName, whitelist, projectId): string`、`saveAsset(opts): Promise<{path, size}>`、`assetPathFor(userName, whitelist, projectId, fileName): string`、`isAllowedUpload(mime, originalName, kind): boolean`

- [ ] **Step 1: 写失败的测试**

创建 `tests/assets/storage.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { assetDir, assetPathFor, isAllowedUpload } from '../../src/assets/storage.js'

const LIST = ['测试存储甲', '测试存储乙']

describe('assetDir —— 路径由会话身份拼出', () => {
  it('目录含用户名和项目 id', () => {
    const dir = assetDir('测试存储甲', LIST, 'proj-123')
    expect(dir).toContain('测试存储甲')
    expect(dir).toContain('proj-123')
  })

  it('名单外用户拿不到路径', () => {
    expect(() => assetDir('黑客', LIST, 'p')).toThrow()
  })

  it('两个用户的素材目录不同', () => {
    expect(assetDir('测试存储甲', LIST, 'p')).not.toBe(assetDir('测试存储乙', LIST, 'p'))
  })
})

describe('assetPathFor —— 防路径穿越', () => {
  it('正常文件名拼出目录下的路径', () => {
    const p = assetPathFor('测试存储甲', LIST, 'proj', 'video.mp4')
    expect(p).toContain('video.mp4')
  })

  it('文件名里的路径穿越被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', '../../../etc/passwd')).toThrow()
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', '..\\..\\windows')).toThrow()
  })

  it('projectId 里的穿越也被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, '../其他人', 'x.mp4')).toThrow()
  })

  it('文件名含斜杠被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', 'sub/dir/x.mp4')).toThrow()
  })
})

describe('isAllowedUpload —— 早失败，不支持的格式当场拒绝', () => {
  it('接受常见视频格式作为背景视频', () => {
    expect(isAllowedUpload('video/mp4', 'a.mp4', 'video')).toBe(true)
    expect(isAllowedUpload('video/quicktime', 'a.mov', 'video')).toBe(true)
  })

  it('接受常见音频格式作为 BGM', () => {
    expect(isAllowedUpload('audio/mpeg', 'a.mp3', 'bgm')).toBe(true)
    expect(isAllowedUpload('audio/wav', 'a.wav', 'bgm')).toBe(true)
  })

  it('拒绝把音频当背景视频传', () => {
    expect(isAllowedUpload('audio/mpeg', 'a.mp3', 'video')).toBe(false)
  })

  it('拒绝可执行文件伪装', () => {
    expect(isAllowedUpload('application/x-executable', 'a.exe', 'video')).toBe(false)
    expect(isAllowedUpload('video/mp4', 'a.exe', 'video')).toBe(false)   // 扩展名也要对
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/assets/storage.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/assets/storage.ts`：

```typescript
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { userDbDir } from '../auth/whitelist.js'
import type { AssetKind } from '../db/user-db.js'

/**
 * 某项目的素材目录。
 *
 * ⚠️ 路径由【会话身份】拼出，绝不接受外部传入的路径（设计文档第 3 节）。
 * userDbDir 先过白名单校验，再拼 projectId——所以"改个 URL 看别人的视频"
 * 这条路在结构上不存在。
 */
export function assetDir (userName: string, whitelist: string[], projectId: string): string {
  const base = userDbDir(userName, whitelist)   // 先过白名单，防穿越
  if (!/^[A-Za-z0-9-]+$/.test(projectId)) {
    throw new Error('非法的项目标识')            // projectId 是 UUID，只允许这些字符
  }
  return resolve(join(base, 'assets', projectId))
}

/** 拼出某个素材文件的完整路径，文件名必须是纯文件名（无路径分隔符） */
export function assetPathFor (
  userName: string, whitelist: string[], projectId: string, fileName: string,
): string {
  const dir = assetDir(userName, whitelist, projectId)
  // 文件名不能含路径分隔符或 ..，basename 后必须与原值相同才放行
  if (fileName !== basename(fileName) || fileName.includes('..') || fileName.includes('\\')) {
    throw new Error('非法的文件名')
  }
  const full = resolve(join(dir, fileName))
  if (!full.startsWith(dir + '/')) {
    throw new Error('拒绝：路径逃逸')            // 双保险
  }
  return full
}

const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm']
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
const AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/flac']
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac']

/**
 * 上传格式白名单。早失败：不支持的格式在上传时就拒绝，
 * 不要等到渲染时 ffmpeg 报一句看不懂的错（设计文档第 13 节）。
 *
 * MIME 和扩展名都要对——单看 MIME 可被伪造，单看扩展名同理。
 */
export function isAllowedUpload (mime: string, originalName: string, kind: AssetKind): boolean {
  const ext = extname(originalName).toLowerCase()
  if (kind === 'video') return VIDEO_MIME.includes(mime) && VIDEO_EXT.includes(ext)
  if (kind === 'bgm') return AUDIO_MIME.includes(mime) && AUDIO_EXT.includes(ext)
  return false   // voice/export 是系统生成的，不接受上传
}

/** 把上传流落盘。返回实际路径与字节数。 */
export async function saveAsset (opts: {
  userName: string; whitelist: string[]; projectId: string
  fileName: string; stream: Readable
}): Promise<{ path: string; size: number }> {
  const dir = assetDir(opts.userName, opts.whitelist, opts.projectId)
  await mkdir(dir, { recursive: true })
  const full = assetPathFor(opts.userName, opts.whitelist, opts.projectId, opts.fileName)

  let size = 0
  opts.stream.on('data', (chunk: Buffer) => { size += chunk.length })
  await pipeline(opts.stream, createWriteStream(full))
  return { path: full, size }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/assets/storage.test.ts`
Expected: 12 passed

- [ ] **Step 5: 提交**

```bash
git add src/assets/storage.ts tests/assets/storage.test.ts
git commit -m "feat: 素材存储 —— 路径由会话身份拼出，防穿越

assetDir 先过白名单再拼 projectId；assetPathFor 拒绝含分隔符/..
的文件名，并二次校验路径未逃逸。上传格式白名单要求 MIME 与扩展名
同时匹配——早失败，不让不支持的格式等到 ffmpeg 才报错。"
```

---

## Task 3: 上传接口

**Files:**
- Create: `src/assets/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/assets/routes.test.ts`

**Interfaces:**
- Consumes: `saveAsset`、`isAllowedUpload`、`openUserDb`、`probeDurationMs`、`requireAuth`、`getSession`
- Produces: `registerAssetRoutes(app, { whitelist })` —— `POST /api/projects/:id/assets?kind=video|bgm`（multipart）、`GET /api/projects/:id/assets`、`DELETE /api/assets/:assetId`

- [ ] **Step 1: 装依赖**

```bash
source ~/.nvm/nvm.sh && nvm use 24
npm install @fastify/multipart
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/assets/routes.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试上传甲', '测试上传乙']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

/** 构造一个 multipart 请求体 */
function multipartBody (fieldName: string, fileName: string, content: Buffer, contentType: string) {
  const boundary = '----testboundary1234567890'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, payload: Buffer.concat([head, content, tail]) }
}

describe('上传接口', () => {
  it('未登录上传返回 401', async () => {
    app = await makeApp()
    const { boundary, payload } = multipartBody('file', 'a.mp4', Buffer.from('x'), 'video/mp4')
    const res = await app.inject({
      method: 'POST', url: '/api/projects/whatever/assets?kind=video',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('拒绝不支持的格式（早失败）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试上传甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
    const { boundary, payload } = multipartBody('file', 'evil.exe', Buffer.from('MZ'), 'application/x-executable')
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${p.id}/assets?kind=video`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: { sj_session: cookie }, payload,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('格式')
  })

  it('上传真实小视频后能列出来，且探测到时长', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试上传甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
    // 用阶段 0 生成的真实小 mp4（黑底 6 秒）
    const video = readFileSync('spikes/karaoke/bg.mp4')
    const { boundary, payload } = multipartBody('file', 'bg.mp4', video, 'video/mp4')
    const up = await app.inject({
      method: 'POST', url: `/api/projects/${p.id}/assets?kind=video`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: { sj_session: cookie }, payload,
    })
    expect(up.statusCode).toBe(200)
    expect(up.json().kind).toBe('video')
    expect(up.json().durationMs).toBeGreaterThan(5000)   // 6 秒的视频

    const list = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/assets`, cookies: { sj_session: cookie } })
    expect(list.json()).toHaveLength(1)
  })

  it('🔒 拿不到别人项目的素材列表', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '测试上传甲')
    const pA = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '甲的' }, cookies: { sj_session: cookieA } })).json()
    const cookieB = await loginAs(app, '测试上传乙')
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pA.id}/assets`, cookies: { sj_session: cookieB } })
    expect(res.statusCode).toBe(404)   // 乙的库里没这个项目
  })
})
```

> **注意**：测试用 `spikes/karaoke/bg.mp4`（阶段 0 生成的 6 秒黑底视频，16KB）。若不存在，先跑 `./spikes/karaoke/run.sh` 生成。

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/assets/routes.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**

创建 `src/assets/routes.ts`：

```typescript
import type { FastifyInstance } from 'fastify'
import { unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openUserDb, type AssetKind } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { saveAsset, isAllowedUpload } from './storage.js'
import { probeDurationMs } from '../render/probe.js'

interface Deps { whitelist: string[] }

export function registerAssetRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
    '/api/projects/:id/assets', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const kind = req.query.kind as AssetKind
      if (kind !== 'video' && kind !== 'bgm') {
        return reply.code(400).send({ error: '只能上传背景视频（kind=video）或背景音乐（kind=bgm）' })
      }

      // 早失败：项目必须存在且属于当前用户（库都是他自己的，查不到即不存在）
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const file = await req.file()
      if (!file) return reply.code(400).send({ error: '没有收到文件' })

      if (!isAllowedUpload(file.mimetype, file.filename, kind)) {
        return reply.code(400).send({
          error: kind === 'video'
            ? '不支持的视频格式，请上传 mp4 / mov / mkv / webm'
            : '不支持的音频格式，请上传 mp3 / wav / aac / m4a / flac',
        })
      }

      // 落盘用随机名 + 原扩展名，避免同名覆盖与奇怪字符
      const storedName = `${randomUUID()}${extname(file.filename).toLowerCase()}`
      const { path, size } = await saveAsset({
        userName: name, whitelist, projectId: req.params.id,
        fileName: storedName, stream: file.file,
      })

      // 探测时长——顺便验证这是个能解码的媒体文件（坏文件当场发现，不拖到导出）
      let durationMs: number | undefined
      try {
        durationMs = await probeDurationMs(path)
      } catch {
        await unlink(path).catch(() => {})
        return reply.code(400).send({ error: '这个文件无法解码，可能已损坏或不是有效的媒体文件' })
      }

      const asset = withUserDb(name, (db) => db.addAsset({
        projectId: req.params.id, kind, path,
        originalName: file.filename, size, durationMs,
      }))
      return asset
    })

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/assets', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })
      return withUserDb(name, (db) => db.listAssets(req.params.id))
    })

  app.delete<{ Params: { assetId: string } }>(
    '/api/assets/:assetId', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const asset = withUserDb(name, (db) => db.getAsset(req.params.assetId))
      if (!asset) return reply.code(404).send({ error: '素材不存在' })
      await unlink(asset.path).catch(() => { /* 文件可能已不在，记录仍要删 */ })
      withUserDb(name, (db) => db.deleteAsset(req.params.assetId))
      return { ok: true }
    })
}
```

- [ ] **Step 5: 注册到 server.ts**

在 `src/server.ts` 顶部加 import：

```typescript
import multipart from '@fastify/multipart'
import { registerAssetRoutes } from './assets/routes.js'
```

在 `buildServer` 的注册块里，`registerProjectRoutes(scope, { whitelist })` 之后加：

```typescript
      // 背景视频可能很大；nginx 侧已放开到 500M
      await scope.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } })
      registerAssetRoutes(scope, { whitelist })
```

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run tests/assets/routes.test.ts`
Expected: 4 passed

- [ ] **Step 7: 全量回归 + 提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/assets/routes.ts src/server.ts tests/assets/routes.test.ts package.json package-lock.json
git commit -m "feat: 素材上传接口

落盘用随机名+原扩展名避免覆盖；上传后立刻 ffprobe 探测时长——
既拿到元数据，也当场发现坏文件，不拖到导出时才炸（早失败）。
格式不支持返回可读的中文提示，说明支持哪些格式。"
```

---

## Task 4: 生成配音接口

**Files:**
- Create: `src/tts/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/tts/routes.test.ts`

**Interfaces:**
- Consumes: `synthesize`、`estimateAudioMs`、`openUserDb`、`assetDir`
- Produces: `registerTtsRoutes(app, { whitelist })` —— `POST /api/projects/:id/voice`

- [ ] **Step 1: 写失败的测试**

创建 `tests/tts/routes.test.ts`（**不真调 Azure**——那会烧配额，只测拦截逻辑）：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试配音甲']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

describe('生成配音接口', () => {
  it('未登录返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/projects/x/voice' })
    expect(res.statusCode).toBe(401)
  })

  it('文案为空时拒绝（早失败，不浪费一次限速配额）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试配音甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '空文案' }, cookies: { sj_session: cookie } })).json()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/voice`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('文案')
  })

  it('文案超长时拒绝，提示超过免费层单次上限', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试配音甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '超长' }, cookies: { sj_session: cookie } })).json()
    // 4000 字 × 196ms × 1.15 ≈ 15 分钟 > 10 分钟上限
    await app.inject({
      method: 'PATCH', url: `/api/projects/${p.id}`,
      payload: { scriptText: '字'.repeat(4000) }, cookies: { sj_session: cookie },
    })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/voice`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/太长|上限|分钟/)
  })

  it('项目不存在返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试配音甲')
    const res = await app.inject({ method: 'POST', url: '/api/projects/无此项目/voice', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })

  it('缺 Azure 配置时返回可读错误，不是 500 堆栈', async () => {
    const saved = process.env.AZURE_SPEECH_KEY
    delete process.env.AZURE_SPEECH_KEY
    try {
      app = await makeApp()
      const cookie = await loginAs(app, '测试配音甲')
      const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
      await app.inject({
        method: 'PATCH', url: `/api/projects/${p.id}`,
        payload: { scriptText: '短文案。' }, cookies: { sj_session: cookie },
      })
      const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/voice`, cookies: { sj_session: cookie } })
      expect(res.statusCode).toBe(500)
      expect(res.json().error).not.toContain('undefined')   // 不能是内部细节
    } finally {
      if (saved) process.env.AZURE_SPEECH_KEY = saved
    }
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/tts/routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/tts/routes.ts`：

```typescript
import type { FastifyInstance } from 'fastify'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { synthesize, estimateAudioMs } from './index.js'
import { normalizeScript } from '../importers/sanitize.js'

interface Deps { whitelist: string[] }

const MAX_AUDIO_MS = 10 * 60 * 1000
const SAFETY = 1.15   // 与 tts/azure.ts 的拦截系数保持一致

export function registerTtsRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  /**
   * 生成配音。设计文档第 6 节：这是【手动触发】的——
   * 改一个字就自动重配会烧配额、撞 F0 的 20 次/60 秒限速。
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/voice', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const text = normalizeScript(project.scriptText)
      if (!text) return reply.code(400).send({ error: '文案是空的，先写点内容再生成配音' })

      // 早失败：超长文案在打到 Azure 之前就拦下，不浪费一次限速配额
      const est = estimateAudioMs(text.length)
      if (est * SAFETY > MAX_AUDIO_MS) {
        return reply.code(400).send({
          error: `文案太长（约 ${Math.round(est / 60000)} 分钟音频），超过免费层单次 10 分钟的上限。请拆成多个项目。`,
        })
      }

      const key = process.env.AZURE_SPEECH_KEY
      const region = process.env.AZURE_SPEECH_REGION
      if (!key || !region) {
        req.log.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION')
        return reply.code(500).send({ error: '服务端未配置配音服务，请联系管理员' })
      }

      withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'generating' }))

      try {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })
        const outPath = join(dir, 'voice.mp3')

        const result = await synthesize({ text, outPath, key, region })

        const updated = withUserDb(name, (db) => {
          // 旧的配音素材记录先清掉，避免堆积
          for (const a of db.listAssets(req.params.id, 'voice')) db.deleteAsset(a.id)
          db.addAsset({
            projectId: req.params.id, kind: 'voice', path: result.audioPath,
            originalName: 'voice.mp3', size: 0, durationMs: result.durationMs,
          })
          return db.updateProject(req.params.id, {
            ttsState: 'ready',
            ttsDurationMs: result.durationMs,
            wordTimingsJson: JSON.stringify(result.words),
          })
        })

        return {
          ttsState: updated!.ttsState,
          durationMs: result.durationMs,
          wordCount: result.words.length,
        }
      } catch (e) {
        withUserDb(name, (db) => db.updateProject(req.params.id, { ttsState: 'error' }))
        req.log.error(e)
        // synthesize 的错误信息本身是给用户看的（配额耗尽/限流/超时），透传
        return reply.code(502).send({ error: e instanceof Error ? e.message : '配音失败' })
      }
    })
}
```

- [ ] **Step 4: 注册到 server.ts**

import 并在 `registerAssetRoutes(scope, { whitelist })` 之后加：

```typescript
      registerTtsRoutes(scope, { whitelist })
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/tts/routes.test.ts`
Expected: 5 passed

- [ ] **Step 6: 全量回归 + 提交**

```bash
git add src/tts/routes.ts src/server.ts tests/tts/routes.test.ts
git commit -m "feat: 生成配音接口

手动触发（设计文档第6节：自动重配会烧配额+撞限速）。
超长文案在打到 Azure 前就拦（含1.15保守系数），不浪费限速配额。
配音结果存 word_timings_json，项目置 ready；失败置 error 并透传
synthesize 的可读错误（配额耗尽/限流/超时都能区分）。"
```

---

## Task 5: 导出队列 + 进度事件

**Files:**
- Create: `src/queue/queue.ts`
- Test: `tests/queue/queue.test.ts`

**Interfaces:**
- Produces: `class ExportQueue` —— `enqueue(jobId: string, run: (onProgress: (pct: number) => void) => Promise<string>): void`、`on(jobId, listener): () => void`、`snapshot(jobId): QueueEvent | null`；类型 `QueueEvent = { jobId: string; status: 'queued'|'running'|'done'|'error'; progress: number; error?: string; outputPath?: string }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/queue/queue.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { ExportQueue } from '../../src/queue/queue.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('ExportQueue —— 串行执行', () => {
  it('任务按入队顺序串行跑，不并发', async () => {
    const q = new ExportQueue()
    const order: string[] = []
    let running = 0
    let maxConcurrent = 0

    const make = (id: string) => async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running)
      order.push(id)
      await tick(30)
      running--
      return `/out/${id}.mp4`
    }

    q.enqueue('a', make('a'))
    q.enqueue('b', make('b'))
    q.enqueue('c', make('c'))
    await tick(200)

    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxConcurrent).toBe(1)     // 串行的证据
  })

  it('进度回调被转成事件推给监听者', async () => {
    const q = new ExportQueue()
    const seen: number[] = []
    q.on('j1', (e) => { if (e.status === 'running') seen.push(e.progress) })
    q.enqueue('j1', async (onProgress) => {
      onProgress(25); onProgress(50); onProgress(100)
      return '/out.mp4'
    })
    await tick(80)
    expect(seen).toContain(25)
    expect(seen).toContain(50)
  })

  it('完成时事件带 outputPath 和 status=done', async () => {
    const q = new ExportQueue()
    let final: unknown = null
    q.on('j2', (e) => { if (e.status === 'done') final = e })
    q.enqueue('j2', async () => '/out/j2.mp4')
    await tick(80)
    expect(final).toMatchObject({ status: 'done', progress: 100, outputPath: '/out/j2.mp4' })
  })

  it('失败时事件带 error，且不影响后续任务', async () => {
    const q = new ExportQueue()
    let failed: unknown = null
    let laterRan = false
    q.on('bad', (e) => { if (e.status === 'error') failed = e })
    q.enqueue('bad', async () => { throw new Error('ffmpeg 挂了') })
    q.enqueue('good', async () => { laterRan = true; return '/ok.mp4' })
    await tick(120)
    expect(failed).toMatchObject({ status: 'error' })
    expect((failed as { error: string }).error).toContain('ffmpeg')
    expect(laterRan).toBe(true)      // 一个失败不能拖垮队列
  })

  it('snapshot 让后加入的监听者能立刻拿到当前状态', async () => {
    const q = new ExportQueue()
    q.enqueue('j3', async (onProgress) => { onProgress(40); await tick(60); return '/o.mp4' })
    await tick(20)
    const snap = q.snapshot('j3')
    expect(snap?.status).toBe('running')
    expect(snap?.progress).toBe(40)
  })

  it('取消订阅后不再收到事件', async () => {
    const q = new ExportQueue()
    let count = 0
    const off = q.on('j4', () => { count++ })
    off()
    q.enqueue('j4', async () => '/o.mp4')
    await tick(60)
    expect(count).toBe(0)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/queue/queue.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/queue/queue.ts`：

```typescript
export type JobStatusEvent = 'queued' | 'running' | 'done' | 'error'

export interface QueueEvent {
  jobId: string
  status: JobStatusEvent
  progress: number
  error?: string
  outputPath?: string
}

type Listener = (e: QueueEvent) => void
type Runner = (onProgress: (pct: number) => void) => Promise<string>

/**
 * 进程内串行导出队列。
 *
 * 为什么串行：ffmpeg 是 CPU 密集的，两个用户的场景下并发渲染只会互相拖慢，
 * 还可能吃满内存。串行简单、可预测（设计文档第 12 节：两个用户上分布式队列纯属自残）。
 *
 * 为什么带 snapshot：SSE 连接可能在任务跑到一半时才建立，
 * 新订阅者必须能立刻拿到当前进度，而不是干等下一次 tick。
 */
export class ExportQueue {
  private pending: Array<{ jobId: string; run: Runner }> = []
  private busy = false
  private listeners = new Map<string, Set<Listener>>()
  private state = new Map<string, QueueEvent>()

  enqueue (jobId: string, run: Runner): void {
    this.setState({ jobId, status: 'queued', progress: 0 })
    this.pending.push({ jobId, run })
    void this.drain()
  }

  on (jobId: string, listener: Listener): () => void {
    if (!this.listeners.has(jobId)) this.listeners.set(jobId, new Set())
    this.listeners.get(jobId)!.add(listener)
    return () => { this.listeners.get(jobId)?.delete(listener) }
  }

  snapshot (jobId: string): QueueEvent | null {
    return this.state.get(jobId) ?? null
  }

  private setState (e: QueueEvent): void {
    this.state.set(e.jobId, e)
    for (const l of this.listeners.get(e.jobId) ?? []) {
      try { l(e) } catch { /* 一个监听者出错不能影响队列 */ }
    }
  }

  private async drain (): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift()!
        this.setState({ jobId: item.jobId, status: 'running', progress: 0 })
        try {
          const outputPath = await item.run((pct) => {
            this.setState({ jobId: item.jobId, status: 'running', progress: Math.round(pct) })
          })
          this.setState({ jobId: item.jobId, status: 'done', progress: 100, outputPath })
        } catch (e) {
          // 一个任务失败绝不能拖垮整个队列——后面的还要跑
          this.setState({
            jobId: item.jobId, status: 'error', progress: 0,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    } finally {
      this.busy = false
    }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/queue/queue.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add src/queue/queue.ts tests/queue/queue.test.ts
git commit -m "feat: 进程内串行导出队列

串行是有意的：ffmpeg CPU 密集，两个用户并发渲染只会互相拖慢。
带 snapshot 让中途建立的 SSE 连接能立刻拿到当前进度，不用干等。
单个任务失败不拖垮队列——后面的照跑。"
```

---

## Task 6: 导出接口 + SSE 进度

**Files:**
- Create: `src/queue/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/queue/routes.test.ts`

**Interfaces:**
- Consumes: `ExportQueue`、`openUserDb`、`segmentLines`、`buildAss`、`parseSrt`、`render`、`assetDir`、`ASPECT_PRESETS`
- Produces: `registerExportRoutes(app, { whitelist, queue })` —— `POST /api/projects/:id/export`、`GET /api/jobs/:jobId/stream`（SSE）、`GET /api/jobs/:jobId/download`

- [ ] **Step 1: 写失败的测试**

创建 `tests/queue/routes.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试导出甲']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

describe('导出接口 —— 提交前校验（早失败）', () => {
  it('未登录返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/projects/x/export' })
    expect(res.statusCode).toBe(401)
  })

  it('没有背景视频时拒绝，提示先传素材', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '无素材' }, cookies: { sj_session: cookie } })).json()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/export`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('背景视频')
  })

  it('没有配音时拒绝，提示先生成配音', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '无配音' }, cookies: { sj_session: cookie } })).json()
    // 只加背景视频，不加配音
    const db = (await import('../../src/db/user-db.js')).openUserDb('测试导出甲', LIST)
    db.addAsset({ projectId: p.id, kind: 'video', path: '/tmp/fake.mp4', originalName: 'a.mp4', size: 1, durationMs: 6000 })
    db.close()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/export`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('配音')
  })

  it('项目不存在返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const res = await app.inject({ method: 'POST', url: '/api/projects/无此项目/export', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })
})

describe('SSE 进度流', () => {
  it('未登录订阅返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/jobs/anyjob/stream' })
    expect(res.statusCode).toBe(401)
  })

  it('不存在的作业返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const res = await app.inject({ method: 'GET', url: '/api/jobs/无此作业/stream', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/queue/routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/queue/routes.ts`：

```typescript
import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { ASPECT_PRESETS } from '../config.js'
import { segmentLines, buildAss } from '../subtitles/index.js'
import { render } from '../render/index.js'
import type { ExportQueue } from './queue.js'
import type { WordTiming, TextOverlay } from '../types.js'

interface Deps { whitelist: string[]; queue: ExportQueue }

const SUBTITLE_MAX_CHARS = 14
const DISCLAIMER = '小说内容纯属虚构，无不良引导'

export function registerExportRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, queue } = deps

  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/export', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const videos = withUserDb(name, (db) => db.listAssets(req.params.id, 'video'))
      if (videos.length === 0) {
        return reply.code(400).send({ error: '还没有背景视频，先上传一个' })
      }
      if (videos.length > 1) {
        // 阶段 1 划界：多片段需要两趟渲染，尚未实现。显式报错而非悄悄出错。
        return reply.code(400).send({ error: '暂时只支持一个背景视频，请删掉多余的' })
      }

      const voices = withUserDb(name, (db) => db.listAssets(req.params.id, 'voice'))
      if (voices.length === 0 || project.ttsState !== 'ready') {
        return reply.code(400).send({ error: '还没有配音，先点「生成配音」' })
      }

      const bgms = withUserDb(name, (db) => db.listAssets(req.params.id, 'bgm'))
      const job = withUserDb(name, (db) => db.createJob(req.params.id))

      queue.enqueue(job.id, async (onProgress) => {
        const dir = assetDir(name, whitelist, req.params.id)
        await mkdir(dir, { recursive: true })

        // 字幕：从存下来的词级时间戳推导，不入库（设计文档第 4 节）
        const words: WordTiming[] = JSON.parse(project.wordTimingsJson ?? '[]')
        const lines = segmentLines(words, SUBTITLE_MAX_CHARS)
        const aspect = ASPECT_PRESETS[project.aspectRatio] ?? ASPECT_PRESETS['9:16']!
        const durationMs = project.ttsDurationMs ?? 0

        const overlays: TextOverlay[] = [
          { content: DISCLAIMER, style: 'Disclaimer', startMs: null, endMs: null },
          { content: project.name, style: 'Title', startMs: null, endMs: null },
        ]
        const ass = buildAss({ lines, overlays, aspect, durationMs, mode: project.subtitleMode })
        const assPath = join(dir, 'subtitle.ass')
        await writeFile(assPath, ass, 'utf-8')

        const outPath = join(dir, 'export.mp4')
        await render({
          clips: [{ path: videos[0]!.path, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
          voicePath: voices[0]!.path,
          bgmPath: bgms[0]?.path,
          bgmVolume: project.bgmVolume,
          assPath, aspect, durationMs, outPath,
        }, onProgress)

        withUserDb(name, (db) => {
          for (const a of db.listAssets(req.params.id, 'export')) db.deleteAsset(a.id)
          db.addAsset({
            projectId: req.params.id, kind: 'export', path: outPath,
            originalName: `${project.name}.mp4`, size: 0, durationMs,
          })
        })
        return outPath
      })

      // 队列事件同步落库，让刷新页面后还能看到结果
      queue.on(job.id, (e) => {
        withUserDb(name, (db) => db.updateJob(job.id, {
          status: e.status === 'queued' ? 'queued' : e.status,
          progress: e.progress,
          error: e.error,
          outputPath: e.outputPath,
        }))
      })

      return { jobId: job.id, status: 'queued' }
    })

  /**
   * SSE 进度流。用 SSE 而非 WebSocket：进度只需服务器单向推，
   * SSE 是这个场景的原生答案（设计文档第 10 节）。
   * nginx 侧已配 proxy_buffering off，否则事件会被缓冲住不实时。
   */
  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/stream', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const job = withUserDb(name, (db) => db.getJob(req.params.jobId))
      if (!job) return reply.code(404).send({ error: '作业不存在' })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',   // 再保险一层：告诉 nginx 别缓冲
      })

      const send = (data: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      // 中途连上的客户端要能立刻看到当前进度，而不是干等
      const snap = queue.snapshot(req.params.jobId)
      send(snap ?? { jobId: job.id, status: job.status, progress: job.progress, error: job.error, outputPath: job.outputPath })

      const off = queue.on(req.params.jobId, (e) => {
        send(e)
        if (e.status === 'done' || e.status === 'error') {
          off()
          reply.raw.end()
        }
      })

      // 已经结束的作业，推完快照就关
      if (job.status === 'done' || job.status === 'error') {
        off()
        reply.raw.end()
        return
      }

      req.raw.on('close', () => { off() })
    })

  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/download', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const job = withUserDb(name, (db) => db.getJob(req.params.jobId))
      if (!job || job.status !== 'done' || !job.outputPath) {
        return reply.code(404).send({ error: '成片还没准备好' })
      }
      const project = withUserDb(name, (db) => db.getProject(job.projectId)) as Project | null
      const fileName = `${project?.name ?? 'surejack'}.mp4`
      reply.header('Content-Type', 'video/mp4')
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      return reply.send(createReadStream(job.outputPath))
    })
}
```

- [ ] **Step 4: 注册到 server.ts**

顶部 import：

```typescript
import { ExportQueue } from './queue/queue.js'
import { registerExportRoutes } from './queue/routes.js'
```

在 `buildServer` 里创建队列（每个 server 实例一个）并注册：

```typescript
  const queue = new ExportQueue()
```
然后在 `registerTtsRoutes(scope, { whitelist })` 之后：
```typescript
      registerExportRoutes(scope, { whitelist, queue })
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/queue/routes.test.ts`
Expected: 6 passed

- [ ] **Step 6: 全量回归 + 提交**

```bash
git add src/queue/routes.ts src/server.ts tests/queue/routes.test.ts
git commit -m "feat: 导出接口 + SSE 进度 + 下载

提交前校验：没背景视频/没配音/多片段都当场拒绝并说清怎么办（早失败）。
SSE 先推快照再推增量——中途连上的客户端不用干等。
队列事件同步落库，刷新页面后仍能看到结果。
下载用 RFC 5987 编码文件名，中文项目名不会乱码。"
```

---

## Task 7: 前端 —— 素材、配音、导出面板

**Files:**
- Create: `web/src/store/pipeline.ts`, `web/src/components/AssetPanel.tsx`, `web/src/components/VoicePanel.tsx`, `web/src/components/ExportPanel.tsx`
- Modify: `web/src/pages/Workspace.tsx`, `web/src/components/ui/Icon.tsx`

**Interfaces:**
- Consumes: `api`、`useProjects`
- Produces: `usePipeline()` store（`assets`、`job`、`loadAssets`、`upload`、`removeAsset`、`generateVoice`、`startExport`、`subscribeJob`）

- [ ] **Step 1: 加需要的图标**

在 `web/src/components/ui/Icon.tsx` 追加（保持既有风格：`viewBox="0 0 24 24"`、`stroke-width 1.5`、圆头圆角、`stroke="currentColor"`、`fill="none"`）：

```tsx
export function IconUpload ({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  )
}

export function IconMic ({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  )
}

export function IconFilm ({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </svg>
  )
}

export function IconMusic ({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

export function IconDownload ({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  )
}
```

- [ ] **Step 2: 管线 store**

创建 `web/src/store/pipeline.ts`：

```typescript
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
```

- [ ] **Step 3: 素材面板**

创建 `web/src/components/AssetPanel.tsx`：

```tsx
import { useRef } from 'react'
import { usePipeline, type Asset } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { IconUpload, IconFilm, IconMusic, IconTrash } from './ui/Icon'

function fmtSize (bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtDuration (ms: number | null): string {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function AssetRow ({ asset, projectId }: { asset: Asset; projectId: string }) {
  const { removeAsset } = usePipeline()
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-line bg-ink-850 px-2.5 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink-100">{asset.originalName}</span>
        <span className="block text-[11px] tabular-nums text-ink-400">
          {fmtSize(asset.size)}{asset.durationMs ? ` · ${fmtDuration(asset.durationMs)}` : ''}
        </span>
      </span>
      <button
        onClick={() => removeAsset(asset.id, projectId)}
        className="rounded p-1 text-ink-400 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
        title="删除"
      ><IconTrash className="size-3.5" /></button>
    </div>
  )
}

function UploadSlot ({ kind, label, icon, projectId }: {
  kind: 'video' | 'bgm'; label: string; icon: React.ReactNode; projectId: string
}) {
  const { assets, upload, uploading } = usePipeline()
  const inputRef = useRef<HTMLInputElement>(null)
  const mine = assets.filter((a) => a.kind === kind)

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        {icon}{label}
      </div>
      <div className="space-y-1.5">
        {mine.map((a) => <AssetRow key={a.id} asset={a} projectId={projectId} />)}
      </div>
      <input
        ref={inputRef} type="file" className="hidden"
        accept={kind === 'video' ? 'video/*' : 'audio/*'}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload(projectId, f, kind)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-ink-300 transition-colors hover:border-accent/40 hover:text-ink-100 disabled:opacity-40"
      >
        <IconUpload className="size-3.5" />
        {uploading ? '上传中…' : mine.length > 0 ? '换一个' : '上传'}
      </button>
    </div>
  )
}

export function AssetPanel () {
  const project = useProjects((s) => s.current())
  const { error } = usePipeline()
  if (!project) return null

  return (
    <div className="space-y-4">
      <UploadSlot kind="video" label="背景视频" icon={<IconFilm className="size-3.5" />} projectId={project.id} />
      <UploadSlot kind="bgm" label="背景音乐" icon={<IconMusic className="size-3.5" />} projectId={project.id} />
      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">{error}</div>}
    </div>
  )
}
```

- [ ] **Step 4: 配音面板**

创建 `web/src/components/VoicePanel.tsx`：

```tsx
import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconMic, IconCheck, IconLoader } from './ui/Icon'

const STATE_TEXT: Record<string, string> = {
  none: '还没生成', generating: '生成中…', ready: '已就绪',
  stale: '文案改过了，需要重新生成', error: '生成失败',
}

export function VoicePanel () {
  const project = useProjects((s) => s.current())
  const reload = useProjects((s) => s.load)
  const { generateVoice, voiceBusy } = usePipeline()
  if (!project) return null

  const state = project.ttsState ?? 'none'
  const seconds = project.ttsDurationMs ? Math.round(project.ttsDurationMs / 1000) : null

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconMic className="size-3.5" />配音
      </div>
      <div className="rounded-lg border border-line bg-ink-850 px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          {state === 'ready' && <IconCheck className="size-3.5 text-accent" />}
          {state === 'generating' && <IconLoader className="size-3.5 animate-spin text-ink-400" />}
          <span className={state === 'stale' ? 'text-accent' : 'text-ink-100'}>{STATE_TEXT[state]}</span>
        </div>
        {seconds !== null && state === 'ready' && (
          <div className="mt-0.5 text-[11px] tabular-nums text-ink-400">
            {Math.floor(seconds / 60)} 分 {seconds % 60} 秒
          </div>
        )}
      </div>
      <Button
        variant={state === 'ready' ? 'ghost' : 'primary'}
        className="mt-1.5 w-full"
        disabled={voiceBusy || !project.scriptText.trim()}
        onClick={async () => { await generateVoice(project.id); await reload() }}
      >
        {voiceBusy ? '生成中…' : state === 'none' ? '生成配音' : '重新生成'}
      </Button>
    </div>
  )
}
```

- [ ] **Step 5: 导出面板**

创建 `web/src/components/ExportPanel.tsx`：

```tsx
import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconDownload } from './ui/Icon'

export function ExportPanel () {
  const project = useProjects((s) => s.current())
  const { job, startExport, assets } = usePipeline()
  if (!project) return null

  const hasVideo = assets.some((a) => a.kind === 'video')
  const voiceReady = project.ttsState === 'ready'
  const canExport = hasVideo && voiceReady
  const running = job?.status === 'queued' || job?.status === 'running'

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-400">导出</div>

      {running && (
        <div className="mb-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-2">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs text-ink-100">
              {job.status === 'queued' ? '排队中' : '合成中'}
            </span>
            <span className="text-xs tabular-nums text-ink-400">{job.progress}%</span>
          </div>
          {/* 进度条：唯一用强调色填充的地方，进度本身就是最该被看见的状态 */}
          <div className="h-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {job?.status === 'error' && (
        <div className="mb-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          {job.error ?? '导出失败'}
        </div>
      )}

      {job?.status === 'done' ? (
        <a
          href={`/api/jobs/${job.jobId}/download`}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconDownload className="size-4" />下载成片
        </a>
      ) : (
        <Button
          variant="primary" className="w-full"
          disabled={!canExport || running}
          onClick={() => startExport(project.id)}
        >
          {running ? '导出中…' : '导出视频'}
        </Button>
      )}

      {!canExport && !running && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          {!hasVideo && '需要先上传背景视频。'}
          {hasVideo && !voiceReady && '需要先生成配音。'}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: 装进右栏**

修改 `web/src/pages/Workspace.tsx`：加 import 与素材加载，把右栏内容换成三个面板 + 原有项目信息。

```tsx
import { usePipeline } from '../store/pipeline'
import { AssetPanel } from '../components/AssetPanel'
import { VoicePanel } from '../components/VoicePanel'
import { ExportPanel } from '../components/ExportPanel'
```

组件内加：

```tsx
  const loadAssets = usePipeline((s) => s.loadAssets)
  const resetPipeline = usePipeline((s) => s.reset)
  useEffect(() => {
    if (project?.id) { resetPipeline(); void loadAssets(project.id) }
  }, [project?.id, loadAssets, resetPipeline])
```

右栏（`<aside className="w-64 ...">`）内容改为：

```tsx
        {project ? (
          <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
            <AssetPanel />
            <VoicePanel />
            <ExportPanel />
          </div>
        ) : (
          <div className="p-4 text-xs text-ink-400">选一个项目</div>
        )}
```

> 右栏宽度从 `w-64` 放宽到 `w-72`——现在里面有三块内容，64 会挤。

- [ ] **Step 7: 类型检查 + 构建**

Run: `cd web && npx tsc -b && npm run build`
Expected: 干净

- [ ] **Step 8: 提交**

```bash
git add web/src
git commit -m "feat: 前端素材 / 配音 / 导出面板

上传走原生 FormData（不经 JSON 封装）；SSE 用原生 EventSource 订阅进度。
配音状态含 stale——改文案后提示需重新生成（设计文档第6节）。
导出前置条件不满足时按钮禁用并说明缺什么，不让用户点了才知道。
进度条是界面上唯一用强调色填充的地方——进度本身最该被看见。"
```

---

## Task 8: 端到端验证 + 上线

**Files:**
- Modify: `deploy/DEPLOY.md`, `docs/superpowers/specs/2026-07-16-surejack-design.md`

- [ ] **Step 1: 全量测试 + 构建**

```bash
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run && npx tsc --noEmit
cd web && npm run build && cd ..
```
Expected: 全绿（约 192 + 15 = 207）

- [ ] **Step 2: 本地端到端跑一条真视频**

用独立端口和独立 auth 库，**不碰生产 `data/auth.db` 和 `data/陈梓昂`**：

```bash
COOKIE_SECRET=e2e-secret-32-chars-long-abcdef node --import tsx -e "
import { buildServer } from './src/server.js'
const app = buildServer({ authDbPath: '/tmp/e2e-auth.db', logger: false })
await app.listen({ port: 8900, host: '127.0.0.1' })
console.log('ready')
" &
```

然后用 playwright（在 `spikes/jassub/node_modules`）走完整流程：登录（用「黄诗婕」，首登设密码）→ 建项目 → 写一段 100 字左右的文案 → 上传 `spikes/karaoke/bg.mp4` 作背景视频 → 点生成配音（**会真调 Azure，烧一点配额，可接受**）→ 点导出 → 等进度条走完 → 确认出现下载按钮。截图存 `/tmp/e2e-*.png`。

**验收判据**：
- 进度条真的从 0 走到 100（证明 SSE 通了）
- 导出完成后 `data/黄诗婕/assets/<项目id>/export.mp4` 存在且能被 ffprobe 读出 1080x1920
- 抽一帧确认：标题、字幕、免责声明都在

- [ ] **Step 3: 清理测试数据**

```bash
rm -f /tmp/e2e-auth.db*
rm -rf "data/黄诗婕"
# 绝不动 data/auth.db 和 data/陈梓昂
```

- [ ] **Step 4: 部署**

```bash
sudo systemctl restart surejack
sleep 3
curl -s -o /dev/null -w "首页 %{http_code}\n" https://surejack.zacchen.win/
curl -s -o /dev/null -w "plus %{http_code}\n" -H "Host: plus.drziangchen.uk" http://127.0.0.1/api/health
```

- [ ] **Step 5: 更新文档**

`deploy/DEPLOY.md` 的运维小节加：
```markdown
- **导出的成片存在**：`data/<姓名>/assets/<项目id>/export.mp4`。
  磁盘吃紧时可以安全删除——重新导出即可再生成。
```

设计文档第 12 节实现状态标注阶段 3B-1 完成：素材上传、配音接口、导出队列、SSE 进度已实现；JASSUB 预览与时间轴仍属 3B-2。

- [ ] **Step 6: 提交并推送**

```bash
git add deploy/DEPLOY.md docs/superpowers/specs/2026-07-16-surejack-design.md
git commit -m "docs: 阶段 3B-1 出片闭环完成并上线"
git push origin master
```

---

## 阶段 3B-1 明确不做的（划界）

- **JASSUB 实时预览 + 时间轴** —— 3B-2。预览要用 Vite 正确集成 JASSUB（见 `spikes/RESULTS.md` 的 Spike 3 提示），是独立一块。
- **多背景视频拼接** —— 需要两趟渲染（阶段 1 划界）。目前上传多个会在导出时显式报错。
- **配音参数 UI（音色/语速）、字幕样式 UI、文本层编辑** —— 这些要和预览一起做才有意义，否则调了看不见效果。
- **画幅切换 UI** —— 后端已支持 `aspectRatio`，前端 UI 留到 3B-2 和预览一起做（换画幅要能立刻看到构图变化）。
- **自带配音+SRT 的前端入口** —— CLI 已支持（阶段 1 Task 11.5），前端入口留到有真实需求时再加。
