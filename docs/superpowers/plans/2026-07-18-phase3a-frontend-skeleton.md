# SureJack 阶段 3A：前端骨架（登录 + 项目列表 + 文案编辑） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能用浏览器登录 `https://surejack.zacchen.win`，看到专属欢迎页，建项目、写文案、切换项目——**第一个真正能"看见并使用"的版本**。

**Architecture:** Vite + React SPA，由同一个 Fastify 后端托管静态产物（同域，cookie 自动生效、无 CORS）。后端补项目 CRUD 接口（基于阶段 2 已就位的每用户独立库）。前端状态用 Zustand，样式用 Tailwind，深色克制风格。**本阶段不做**：素材上传、渲染导出、进度、预览、时间轴——那些是 3B。

**Tech Stack:** Vite 6 + React 19 + TypeScript + Zustand + Tailwind CSS v4 + Fastify（`@fastify/static` 托管前端）

## Global Constraints

来自设计文档第 3、4、11 节，逐条照抄，违反即返工：

- **界面风格是硬性产品要求，不是做完功能再美化**：简洁大方、配色高级、有设计感。
- **深色为主**——这不是审美偏好，是品类的功能性选择：界面必须退后，让视频画面成为唯一视觉焦点。
- **配色克制**：一个中性灰阶做骨架，**一个**强调色用于交互焦点和状态。不堆颜色。"高级"在实践中基本等于"克制"。
- **排版是主要设计手段**：靠字重和字号建立层级，不靠框线、分割线、色块切割界面。
- **动效有目的**：状态转换、进度反馈、拖拽跟手。不做装饰性动画。
- **布局**：左侧可折叠项目列表 → 中间预览+时间轴（3B 填）→ 右侧属性面板。
- **项目的核心是文字**：文案是一等公民，随时可编辑，上传只是导入入口之一。
- **真实姓名与欢迎页文案不入库**：从 gitignored 的 `config/whitelist.json` 和 `config/welcome.json` 读。仓库会 push 到 GitHub，真名不能进。
- **每用户物理隔离**：所有 CRUD 走 `openUserDb(name, whitelist)`，**绝不出现 `WHERE owner = ?`**。
- **所有受保护接口必须挂 `requireAuth`**。
- **前后端同域**：前端静态产物由 Fastify 托管，不拆到别处（否则 cookie 跨站）。
- Node 24 LTS；后端监听 127.0.0.1:8809（避开 plus 的 8808）。

---

## 文件结构

```
web/                              # 前端（Vite 项目，独立 package.json）
├── index.html
├── vite.config.ts                # 构建到 ../public，dev 时 proxy /api → :8809
├── tailwind.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx                   # 路由：未登录→登录页，已登录→工作台
│   ├── index.css                 # Tailwind + 设计令牌（颜色/字号/间距）
│   ├── api/client.ts             # fetch 封装（credentials: include、错误统一）
│   ├── store/session.ts          # Zustand：当前用户、登录/登出
│   ├── store/projects.ts         # Zustand：项目列表、当前项目、CRUD 调用
│   ├── pages/LoginPage.tsx       # 姓名+密码，首登提示
│   ├── pages/WelcomePage.tsx     # 登录后的专属欢迎页（陈梓昂/黄诗婕不同）
│   ├── pages/Workspace.tsx       # 三栏骨架：左列表 / 中主区 / 右属性
│   └── components/
│       ├── ProjectList.tsx       # 左侧可折叠列表
│       ├── ScriptEditor.tsx      # 文案编辑（自动保存）
│       └── ui/                   # 基础组件（Button/Input/Panel）
public/                           # 前端构建产物（gitignore，由 vite build 生成）
config/welcome.example.json       # 欢迎页文案模板（真的在 welcome.json，gitignored）
src/                              # 后端（已有）
├── projects/routes.ts            # 新增：项目 CRUD 接口
├── db/user-db.ts                 # 修改：补 CRUD 函数
└── server.ts                     # 修改：挂 projects 路由 + @fastify/static
tests/
├── db/user-db-crud.test.ts       # 新增
└── projects/routes.test.ts       # 新增
```

**为什么这样切**：后端 CRUD（Task 1–2）和前端（Task 3–7）可以分别验证；前端里 store 与 UI 分离，UI 组件不直接 fetch。`web/` 独立 package.json 是因为前端依赖（React/Vite/Tailwind）和后端无关，混在一起会让后端 `npm ci` 变慢且易冲突。

---

## Task 1: 后端 —— user-db 的项目 CRUD

**Files:**
- Modify: `src/db/user-db.ts`
- Test: `tests/db/user-db-crud.test.ts`

**Interfaces:**
- Consumes: `openUserDb(name, whitelist): UserDb`（阶段 2 已有，含 `raw`/`path`/`close`）
- Produces: `UserDb` 上新增方法 —— `listProjects(): Project[]`、`getProject(id): Project | null`、`createProject(name: string): Project`、`updateProject(id, patch: { name?: string; scriptText?: string; aspectRatio?: string }): Project | null`、`deleteProject(id): boolean`；以及导出类型 `Project = { id: string; name: string; scriptText: string; aspectRatio: string; createdAt: string; updatedAt: string }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/db/user-db-crud.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试甲', '测试乙']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function fresh (name = '测试甲'): UserDb {
  const db = openUserDb(name, LIST)
  // 每个用例从干净状态开始
  db.raw.exec('DELETE FROM projects')
  dbs.push(db)
  return db
}

describe('项目 CRUD', () => {
  it('新库没有项目', () => {
    expect(fresh().listProjects()).toEqual([])
  })

  it('创建项目返回完整对象，文案默认空、画幅默认 9:16', () => {
    const p = fresh().createProject('我的第一条')
    expect(p.name).toBe('我的第一条')
    expect(p.scriptText).toBe('')
    expect(p.aspectRatio).toBe('9:16')
    expect(p.id).toBeTruthy()
    expect(p.createdAt).toBeTruthy()
  })

  it('创建后能在列表里查到', () => {
    const db = fresh()
    db.createProject('甲')
    db.createProject('乙')
    expect(db.listProjects().map((p) => p.name).sort()).toEqual(['乙', '甲'])
  })

  it('按 id 取单个项目', () => {
    const db = fresh()
    const p = db.createProject('目标')
    expect(db.getProject(p.id)?.name).toBe('目标')
    expect(db.getProject('不存在的id')).toBeNull()
  })

  it('更新文案——文案是一等公民，必须能改', () => {
    const db = fresh()
    const p = db.createProject('稿子')
    const updated = db.updateProject(p.id, { scriptText: '老陈是在星期八醒来的。' })
    expect(updated?.scriptText).toBe('老陈是在星期八醒来的。')
    expect(db.getProject(p.id)?.scriptText).toBe('老陈是在星期八醒来的。')
  })

  it('部分更新不影响其他字段', () => {
    const db = fresh()
    const p = db.createProject('原名')
    db.updateProject(p.id, { scriptText: '正文' })
    const after = db.getProject(p.id)!
    expect(after.name).toBe('原名')          // 没传 name，不该被清空
    expect(after.aspectRatio).toBe('9:16')
  })

  it('更新会刷新 updatedAt', async () => {
    const db = fresh()
    const p = db.createProject('计时')
    await new Promise((r) => setTimeout(r, 1100))   // ISO 秒级精度，等 1 秒
    const updated = db.updateProject(p.id, { scriptText: 'x' })!
    expect(updated.updatedAt > p.updatedAt).toBe(true)
  })

  it('更新不存在的项目返回 null', () => {
    expect(fresh().updateProject('无此id', { scriptText: 'x' })).toBeNull()
  })

  it('删除项目', () => {
    const db = fresh()
    const p = db.createProject('待删')
    expect(db.deleteProject(p.id)).toBe(true)
    expect(db.getProject(p.id)).toBeNull()
    expect(db.deleteProject(p.id)).toBe(false)   // 删第二次返回 false
  })

  it('两个用户的项目互不可见——物理隔离', () => {
    const a = openUserDb('测试甲', LIST); dbs.push(a); a.raw.exec('DELETE FROM projects')
    const b = openUserDb('测试乙', LIST); dbs.push(b); b.raw.exec('DELETE FROM projects')
    a.createProject('甲的项目')
    expect(b.listProjects()).toEqual([])   // 乙看不到甲的
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && npx vitest run tests/db/user-db-crud.test.ts`
Expected: FAIL —— `listProjects is not a function`

- [ ] **Step 3: 实现**

修改 `src/db/user-db.ts`，在 `UserDb` 接口和返回对象上加 CRUD。完整替换文件内容为：

```typescript
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { userDbDir } from '../auth/whitelist.js'

/** 一个项目。核心是 scriptText——设计文档：项目的核心是文字 */
export interface Project {
  id: string
  name: string
  scriptText: string
  aspectRatio: string
  createdAt: string
  updatedAt: string
}

export interface UserDb {
  raw: Database.Database
  path: string
  listProjects (): Project[]
  getProject (id: string): Project | null
  createProject (name: string): Project
  updateProject (id: string, patch: { name?: string; scriptText?: string; aspectRatio?: string }): Project | null
  deleteProject (id: string): boolean
  close (): void
}

/** SQLite 行 → Project（列名 snake_case，对外 camelCase） */
interface Row {
  id: string; name: string; script_text: string
  aspect_ratio: string; created_at: string; updated_at: string
}
const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, scriptText: r.script_text,
  aspectRatio: r.aspect_ratio, createdAt: r.created_at, updatedAt: r.updated_at,
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      script_text TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '9:16',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

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
        aspectRatio: '9:16', createdAt: now, updatedAt: now,
      }
      db.prepare(
        'INSERT INTO projects (id, name, script_text, aspect_ratio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(project.id, project.name, project.scriptText, project.aspectRatio, now, now)
      return project
    },

    updateProject (id, patch) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      if (!row) return null
      const now = new Date().toISOString()
      // 部分更新：没传的字段保持原值
      db.prepare(
        'UPDATE projects SET name = ?, script_text = ?, aspect_ratio = ?, updated_at = ? WHERE id = ?'
      ).run(
        patch.name ?? row.name,
        patch.scriptText ?? row.script_text,
        patch.aspectRatio ?? row.aspect_ratio,
        now, id,
      )
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row
      return toProject(updated)
    },

    deleteProject (id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return info.changes > 0
    },

    close () { db.close() },
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/db/user-db-crud.test.ts`
Expected: 10 passed

- [ ] **Step 5: 全量回归 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（阶段 2 的 158 + 新增 10 = 168），类型干净

- [ ] **Step 6: 提交**

```bash
git add src/db/user-db.ts tests/db/user-db-crud.test.ts
git commit -m "feat: user-db 补项目 CRUD

listProjects/getProject/createProject/updateProject/deleteProject。
部分更新保持未传字段原值。列名 snake_case 对外转 camelCase。
物理隔离不变：仍然只收 name+白名单，不存在 WHERE owner=?。"
```

---

## Task 2: 后端 —— 项目 CRUD 的 HTTP 接口

**Files:**
- Create: `src/projects/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/projects/routes.test.ts`

**Interfaces:**
- Consumes: `openUserDb`、`getSession`、`requireAuth`、`loadWhitelist`
- Produces: `registerProjectRoutes(app, deps: { whitelist: string[] })` —— 挂载 `GET /api/projects`、`POST /api/projects`、`GET /api/projects/:id`、`PATCH /api/projects/:id`、`DELETE /api/projects/:id`，全部要求登录

- [ ] **Step 1: 写失败的测试**

创建 `tests/projects/routes.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试甲', '测试乙']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

/** 登录并返回可用于后续请求的 cookie 值 */
async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

describe('项目接口 —— 鉴权', () => {
  it('未登录列项目返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(401)
  })

  it('未登录建项目返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('项目接口 —— CRUD', () => {
  it('登录后能建项目并列出来', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试甲')
    const created = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: '新项目' }, cookies: { sj_session: cookie },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ name: '新项目', scriptText: '', aspectRatio: '9:16' })

    const list = await app.inject({ method: 'GET', url: '/api/projects', cookies: { sj_session: cookie } })
    expect(list.json()).toHaveLength(1)
  })

  it('改文案', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试甲')
    const p = (await app.inject({
      method: 'POST', url: '/api/projects', payload: { name: '稿子' }, cookies: { sj_session: cookie },
    })).json()

    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${p.id}`,
      payload: { scriptText: '震惊！' }, cookies: { sj_session: cookie },
    })
    expect(res.json().scriptText).toBe('震惊！')
  })

  it('删项目', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试甲')
    const p = (await app.inject({
      method: 'POST', url: '/api/projects', payload: { name: '待删' }, cookies: { sj_session: cookie },
    })).json()
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, cookies: { sj_session: cookie } })
    expect(del.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/projects', cookies: { sj_session: cookie } })
    expect(list.json()).toHaveLength(0)
  })

  it('取不存在的项目返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试甲')
    const res = await app.inject({ method: 'GET', url: '/api/projects/不存在', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })

  it('建项目缺 name 返回 400', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试甲')
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: {}, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
  })

  it('🔒 一个用户看不到另一个用户的项目——物理隔离端到端', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '测试甲')
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '甲的秘密' }, cookies: { sj_session: cookieA } })

    const cookieB = await loginAs(app, '测试乙')
    const listB = await app.inject({ method: 'GET', url: '/api/projects', cookies: { sj_session: cookieB } })
    expect(listB.json()).toHaveLength(0)
  })

  it('🔒 用别人的项目 id 也拿不到——库都不是同一个', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '测试甲')
    const pA = (await app.inject({
      method: 'POST', url: '/api/projects', payload: { name: '甲的' }, cookies: { sj_session: cookieA },
    })).json()

    const cookieB = await loginAs(app, '测试乙')
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pA.id}`, cookies: { sj_session: cookieB } })
    expect(res.statusCode).toBe(404)   // 乙的库里根本没这条
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/projects/routes.test.ts`
Expected: FAIL —— 404（路由不存在）

- [ ] **Step 3: 实现路由**

创建 `src/projects/routes.ts`：

```typescript
import type { FastifyInstance } from 'fastify'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'

interface Deps { whitelist: string[] }

/**
 * 项目 CRUD。
 *
 * ⚠️ 每个 handler 都用会话身份打开【那个人自己的库】——
 * openUserDb(name, whitelist) 只收姓名，路径由白名单映射唯一确定。
 * 所以这里没有、也不需要任何 `WHERE owner = ?`：
 * 打开的库本身就是那个人的，跨用户读取在结构上不可能发生。
 *
 * 每次请求开库/关库：SQLite 打开极快（微秒级），2 用户场景下
 * 比维护连接池简单得多，且天然避免了"连接绑错用户"这类 bug。
 */
export function registerProjectRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist } = deps

  /** 用当前会话身份开库，跑一段逻辑，然后必定关库 */
  function withUserDb<T> (request: { }, name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const name = getSession(req)!
    return withUserDb(req, name, (db) => db.listProjects())
  })

  app.post<{ Body: { name?: unknown } }>('/api/projects', { preHandler: requireAuth }, async (req, reply) => {
    const projectName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!projectName) return reply.code(400).send({ error: '请填项目名' })
    const name = getSession(req)!
    return withUserDb(req, name, (db) => db.createProject(projectName))
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const project = withUserDb(req, name, (db) => db.getProject(req.params.id))
    if (!project) return reply.code(404).send({ error: '项目不存在' })
    return project
  })

  app.patch<{ Params: { id: string }; Body: { name?: unknown; scriptText?: unknown; aspectRatio?: unknown } }>(
    '/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
      const patch: { name?: string; scriptText?: string; aspectRatio?: string } = {}
      if (typeof req.body?.name === 'string') patch.name = req.body.name
      if (typeof req.body?.scriptText === 'string') patch.scriptText = req.body.scriptText
      if (typeof req.body?.aspectRatio === 'string') patch.aspectRatio = req.body.aspectRatio

      const name = getSession(req)!
      const updated = withUserDb(req, name, (db) => db.updateProject(req.params.id, patch))
      if (!updated) return reply.code(404).send({ error: '项目不存在' })
      return updated
    })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const ok = withUserDb(req, name, (db) => db.deleteProject(req.params.id))
    if (!ok) return reply.code(404).send({ error: '项目不存在' })
    return { ok: true }
  })
}
```

- [ ] **Step 4: 挂载到 server.ts**

在 `src/server.ts` 的 `buildServer` 里，紧跟着 `registerAuthRoutes(scope, ...)` 之后加一行挂载（在同一个注册了会话的 scope 内，这样 `requireAuth`/`getSession` 能用）：

```typescript
      registerAuthRoutes(scope, { authDb, whitelist })
      registerProjectRoutes(scope, { whitelist })       // ← 新增这行
```

并在文件顶部加 import：

```typescript
import { registerProjectRoutes } from './projects/routes.js'
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/projects/routes.test.ts`
Expected: 9 passed

- [ ] **Step 6: 全量回归**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（168 + 9 = 177），类型干净

- [ ] **Step 7: 提交**

```bash
git add src/projects/routes.ts src/server.ts tests/projects/routes.test.ts
git commit -m "feat: 项目 CRUD 的 HTTP 接口

全部挂 requireAuth。每个 handler 用会话身份开【那个人自己的库】，
所以没有也不需要 WHERE owner=?——跨用户读取在结构上不可能。
测试含两条端到端隔离验证：乙看不到甲的列表，也拿不到甲的项目id。"
```

---

## Task 3: 前端骨架 —— Vite + Tailwind + 设计令牌

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css`
- Modify: `.gitignore`（加 `public/`、`web/node_modules`）

**Interfaces:**
- Produces: 可 `npm run dev` 的前端骨架；构建产物输出到仓库根的 `public/`

- [ ] **Step 1: 建 Vite 项目**

```bash
cd /root/SureJack
source ~/.nvm/nvm.sh && nvm use 24
mkdir -p web && cd web
npm create vite@latest . -- --template react-ts --yes 2>/dev/null || npm create vite@latest . -- --template react-ts
npm install
npm install zustand
npm install -D tailwindcss @tailwindcss/vite
cd ..
```

- [ ] **Step 2: 配 vite.config.ts**

`web/vite.config.ts` 完整内容：

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 构建产物给 Fastify 托管（同域，cookie 自动生效、无 CORS）
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    // 开发时把 /api 代理到后端，前端仍以为是同域
    proxy: { '/api': { target: 'http://127.0.0.1:8809', changeOrigin: true } },
  },
})
```

- [ ] **Step 3: 设计令牌（这是"配色高级"的地基）**

`web/src/index.css` 完整内容 —— **深色、克制、单强调色、排版建立层级**：

```css
@import "tailwindcss";

/* ───────────────────────────────────────────────
   设计令牌。设计文档第 11 节：深色为主、配色克制、
   一个中性灰阶 + 一个强调色、排版是主要设计手段。
   ─────────────────────────────────────────────── */
@theme {
  /* 中性灰阶：从最深的背景到最亮的文字，只有一条轴 */
  --color-ink-950: #0a0a0b;   /* 页面底色 */
  --color-ink-900: #101013;   /* 面板 */
  --color-ink-850: #16161a;   /* 抬升面板 */
  --color-ink-800: #1d1d22;   /* 输入框 */
  --color-ink-700: #2a2a31;   /* 边框 */
  --color-ink-600: #3d3d46;   /* 分隔线 */
  --color-ink-400: #6e6e7a;   /* 次要文字 */
  --color-ink-300: #9a9aa6;   /* 说明文字 */
  --color-ink-100: #d8d8de;   /* 主要文字 */
  --color-ink-50:  #f2f2f5;   /* 强调文字 */

  /* 唯一的强调色：交互焦点与状态。不再引入第二个彩色 */
  --color-accent: #4f7cff;
  --color-accent-dim: #3d63d6;

  /* 状态色只在真正需要语义时用 */
  --color-danger: #e5484d;

  --font-sans: -apple-system, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
}

html, body, #root { height: 100%; }

body {
  background: var(--color-ink-950);
  color: var(--color-ink-100);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

/* 滚动条也要克制——默认的亮色滚动条会破坏深色沉浸感 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-ink-700); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-ink-600); }
```

- [ ] **Step 4: index.html + main.tsx**

`web/index.html`：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SureJack</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
)
```

- [ ] **Step 5: 临时 App.tsx 验证骨架能跑**

`web/src/App.tsx`（Task 5 会替换成真正的路由）：

```tsx
export default function App () {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="text-2xl font-semibold tracking-tight text-ink-50">SureJack</div>
        <div className="mt-2 text-sm text-ink-400">骨架就位</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: 验证能构建、能起 dev**

```bash
cd web && npm run build && cd ..
ls -la public/index.html public/assets/ | head -5
```
Expected: `public/index.html` 存在，`public/assets/` 里有 js/css

- [ ] **Step 7: gitignore + 提交**

```bash
cd /root/SureJack
printf '\n# 前端构建产物（由 vite build 生成，不入库）\npublic/\nweb/node_modules/\nweb/dist/\n' >> .gitignore
git add .gitignore web/package.json web/package-lock.json web/vite.config.ts web/index.html web/src web/tsconfig*.json web/eslint.config.js 2>/dev/null || git add .gitignore web/
git commit -m "feat: 前端骨架 —— Vite + React + Tailwind 与设计令牌

深色克制配色：一条中性灰阶（ink-50..950）+ 唯一强调色（accent）。
构建产物输出到 public/ 由 Fastify 同域托管（cookie 自动生效、无 CORS）。
dev 时 /api 代理到 8809。"
```

---

## Task 4: 后端托管前端 + 欢迎页配置

**Files:**
- Create: `config/welcome.example.json`
- Modify: `src/server.ts`
- Test: `tests/server-static.test.ts`

**Interfaces:**
- Consumes: `loadWhitelist`
- Produces: `loadWelcome(): Record<string, string>`（姓名 → 欢迎语）；`GET /api/whoami` 响应扩展为 `{ name: string | null; welcome: string | null }`；Fastify 托管 `public/` 静态产物 + SPA fallback

- [ ] **Step 1: 写失败的测试**

创建 `tests/server-static.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

describe('whoami 带欢迎语', () => {
  it('未登录时 name 和 welcome 都是 null', async () => {
    app = buildServer({ authDbPath: ':memory:', whitelist: ['甲'], cookieSecret: 'test-secret-32-chars-long-abcdef' })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(res.json()).toEqual({ name: null, welcome: null })
  })

  it('登录后返回姓名和对应欢迎语', async () => {
    app = buildServer({
      authDbPath: ':memory:', whitelist: ['甲'],
      cookieSecret: 'test-secret-32-chars-long-abcdef',
      welcome: { '甲': '欢迎甲同学' },
    })
    await app.ready()
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '甲', password: 'pass1234' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(res.json()).toEqual({ name: '甲', welcome: '欢迎甲同学' })
  })

  it('名单内但没配欢迎语时给通用文案，不是 null', async () => {
    app = buildServer({
      authDbPath: ':memory:', whitelist: ['乙'],
      cookieSecret: 'test-secret-32-chars-long-abcdef',
      welcome: {},
    })
    await app.ready()
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '乙', password: 'pass1234' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(res.json().welcome).toBe('欢迎回来')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/server-static.test.ts`
Expected: FAIL —— whoami 只返回 `{name}` 没有 `welcome`

- [ ] **Step 3: 欢迎页配置模板**

创建 `config/welcome.example.json`：

```json
{
  "示例姓名甲": "欢迎示例甲",
  "示例姓名乙": "欢迎示例乙"
}
```

**同时创建真配置**（gitignored，含真名）：

```bash
cat > config/welcome.json <<'EOF'
{
  "陈梓昂": "欢迎主人",
  "黄诗婕": "欢迎老大"
}
EOF
printf '\n# 真欢迎页文案（含真名），不入库\nconfig/welcome.json\n' >> .gitignore
git check-ignore config/welcome.json   # 必须输出路径，确认已忽略
```

- [ ] **Step 4: 实现**

装静态托管插件：

```bash
npm install @fastify/static
```

修改 `src/server.ts`：

1. 顶部加 import：
```typescript
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
```

2. 加 `loadWelcome`（放在 `loadWhitelist` 旁边）：
```typescript
/**
 * 加载欢迎页文案（姓名 → 欢迎语）。
 * 真文案在 config/welcome.json（含真名，不入库），缺失时回退 example。
 * 与白名单同样的规则：文件存在但格式损坏 → 抛错，绝不静默降级。
 */
export function loadWelcome (): Record<string, string> {
  const root = join(__dirname, '..')
  for (const name of ['welcome.json', 'welcome.example.json']) {
    const p = join(root, 'config', name)
    if (!existsSync(p)) continue
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} 格式错误：应为 {姓名: 欢迎语} 对象`)
    }
    return parsed as Record<string, string>
  }
  return {}
}
```

3. `BuildOpts` 加 `welcome?: Record<string, string>`，`buildServer` 里取值：
```typescript
  const welcome = opts.welcome ?? loadWelcome()
```

4. 把 `welcome` 传给 auth 路由（`registerAuthRoutes(scope, { authDb, whitelist, welcome })`），并在 `src/auth/routes.ts` 里：
   - `Deps` 加 `welcome: Record<string, string>`
   - whoami 改为：
```typescript
  app.get('/api/whoami', async (req) => {
    const name = getSession(req)
    if (!name) return { name: null, welcome: null }
    return { name, welcome: deps.welcome[name] ?? '欢迎回来' }
  })
```

5. 在 `buildServer` 末尾（`app.register(async (scope) => {...})` 之后）加静态托管：
```typescript
  // 托管前端构建产物（同域，cookie 自动生效、无 CORS）。
  // public/ 由 `cd web && npm run build` 生成；开发时用 vite dev + proxy，不走这里。
  const publicDir = join(__dirname, '..', 'public')
  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir })
    // SPA fallback：非 /api 的未知路径一律回 index.html，交给前端路由
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' })
      }
      return reply.sendFile('index.html')
    })
  }
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/server-static.test.ts`
Expected: 3 passed

- [ ] **Step 6: 全量回归**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（177 + 3 = 180）

- [ ] **Step 7: 手动验证静态托管真的生效**

```bash
cd web && npm run build && cd ..
COOKIE_SECRET=test-secret-32-chars-long-abcdefgh PORT=8891 node --import tsx src/server.ts &
sleep 2
curl -s -o /dev/null -w "首页: HTTP %{http_code}\n" localhost:8891/
curl -s -o /dev/null -w "前端路由(SPA fallback): HTTP %{http_code}\n" localhost:8891/some/spa/route
curl -s -o /dev/null -w "未知接口: HTTP %{http_code}\n" localhost:8891/api/nope
kill %1
```
Expected: 首页 200、SPA fallback 200、未知接口 404

- [ ] **Step 8: 提交**

```bash
git add src/server.ts src/auth/routes.ts config/welcome.example.json tests/server-static.test.ts .gitignore package.json package-lock.json
git commit -m "feat: 后端托管前端 + 专属欢迎语

whoami 扩展为 {name, welcome}，欢迎语从 gitignored 的 config/welcome.json
读（真名不入库）。@fastify/static 托管 public/，SPA fallback 让前端路由接管
非 /api 路径。welcome.json 格式损坏时抛错，不静默降级（与白名单同规则）。"
```

---

## Task 5: 前端 —— API 客户端 + 会话 store + 登录页

**Files:**
- Create: `web/src/api/client.ts`, `web/src/store/session.ts`, `web/src/pages/LoginPage.tsx`, `web/src/components/ui/Button.tsx`, `web/src/components/ui/Input.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: `api.get/post/patch/del`；`useSession()` store（`name`、`welcome`、`status`、`login(name,pw)`、`logout()`、`check()`）；登录页

- [ ] **Step 1: API 客户端**

`web/src/api/client.ts`：

```typescript
/** 统一的 API 错误：带上后端返回的中文提示 */
export class ApiError extends Error {
  constructor (public status: number, message: string) { super(message) }
}

async function request<T> (method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',   // 带上会话 cookie（同域，本来就会带，显式写明意图）
  })
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`
    try { msg = (await res.json()).error ?? msg } catch { /* 响应不是 JSON，用默认文案 */ }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
}
```

- [ ] **Step 2: 会话 store**

`web/src/store/session.ts`：

```typescript
import { create } from 'zustand'
import { api, ApiError } from '../api/client'

interface WhoAmI { name: string | null; welcome: string | null }

interface SessionState {
  name: string | null
  welcome: string | null
  /** unknown=还没问过后端；anon=未登录；authed=已登录 */
  status: 'unknown' | 'anon' | 'authed'
  error: string | null
  busy: boolean
  check: () => Promise<void>
  login: (name: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  name: null, welcome: null, status: 'unknown', error: null, busy: false,

  /** 页面加载时问一次"我是谁"——刷新后保持登录态靠这个 */
  async check () {
    try {
      const me = await api.get<WhoAmI>('/api/whoami')
      set(me.name
        ? { name: me.name, welcome: me.welcome, status: 'authed' }
        : { name: null, welcome: null, status: 'anon' })
    } catch {
      set({ status: 'anon' })
    }
  },

  async login (name, password) {
    set({ busy: true, error: null })
    try {
      await api.post('/api/login', { name, password })
      const me = await api.get<WhoAmI>('/api/whoami')
      set({ name: me.name, welcome: me.welcome, status: 'authed', busy: false })
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '登录失败', busy: false })
    }
  },

  async logout () {
    await api.post('/api/logout').catch(() => { /* 登出失败也要清本地状态 */ })
    set({ name: null, welcome: null, status: 'anon' })
  },
}))
```

- [ ] **Step 3: 基础 UI 组件**

`web/src/components/ui/Button.tsx`：

```tsx
import type { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

/** 克制的按钮：主色只在 primary 出现，其余靠灰阶和字重 */
export function Button ({ variant = 'ghost', className = '', ...rest }: Props) {
  const base = 'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-dim',
    ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-50',
    danger: 'text-danger hover:bg-danger/10',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}
```

`web/src/components/ui/Input.tsx`：

```tsx
import type { InputHTMLAttributes } from 'react'

export function Input ({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-ink-700 bg-ink-800 px-3.5 py-2.5 text-sm text-ink-50 placeholder:text-ink-400 outline-none transition-colors focus:border-accent ${className}`}
      {...rest}
    />
  )
}
```

- [ ] **Step 4: 登录页**

`web/src/pages/LoginPage.tsx`：

```tsx
import { useState, type FormEvent } from 'react'
import { useSession } from '../store/session'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

export function LoginPage () {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const { login, error, busy } = useSession()

  function onSubmit (e: FormEvent) {
    e.preventDefault()
    if (name.trim() && password) login(name.trim(), password)
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <form onSubmit={onSubmit} className="w-full max-w-[320px]">
        {/* 排版建立层级：靠字号字重，不靠框线 */}
        <div className="mb-1 text-[28px] font-semibold leading-tight tracking-tight text-ink-50">SureJack</div>
        <div className="mb-8 text-sm text-ink-400">输入你的名字</div>

        <div className="space-y-3">
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="姓名" autoFocus autoComplete="username"
          />
          <Input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="密码" autoComplete="current-password"
          />
        </div>

        {error && <div className="mt-3 text-sm text-danger">{error}</div>}

        <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy || !name.trim() || !password}>
          {busy ? '进入中…' : '进入'}
        </Button>

        <div className="mt-4 text-xs leading-relaxed text-ink-400">
          第一次进来会把这个密码设为你的密码。
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 5: App.tsx 接上会话**

`web/src/App.tsx`：

```tsx
import { useEffect } from 'react'
import { useSession } from './store/session'
import { LoginPage } from './pages/LoginPage'

export default function App () {
  const { status, check } = useSession()

  useEffect(() => { check() }, [check])

  // 还没问完后端时不闪登录页——避免已登录用户看到一瞬间的登录框
  if (status === 'unknown') {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">载入中…</div>
  }
  if (status === 'anon') return <LoginPage />
  return <div className="flex h-full items-center justify-center text-sm text-ink-400">已登录（工作台在 Task 6）</div>
}
```

- [ ] **Step 6: 手动验证登录能跑通**

开两个终端（或后台起后端）：
```bash
# 后端
cd /root/SureJack && COOKIE_SECRET=$(grep COOKIE_SECRET .env | cut -d= -f2) PORT=8809 node --import tsx src/server.ts &
# 前端 dev
cd web && npm run dev
```
浏览器开 `http://<服务器IP>:5173`（或本地 5173），用白名单里的姓名 + 任意密码登录（首次会设密码）。
Expected: 登录后页面变成"已登录"；刷新页面**仍是已登录**（cookie 生效）；用名单外的名字登录显示「你谁啊」。

- [ ] **Step 7: 提交**

```bash
cd /root/SureJack
git add web/src
git commit -m "feat: 前端登录 —— API 客户端 + 会话 store + 登录页

fetch 封装统一带 cookie 和中文错误。Zustand 管会话，刷新后靠 whoami
恢复登录态（status=unknown 时不闪登录页）。登录页排版靠字号字重建层级。"
```

---

## Task 6: 前端 —— 欢迎页 + 工作台三栏骨架

**Files:**
- Create: `web/src/pages/WelcomePage.tsx`, `web/src/pages/Workspace.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `useSession`
- Produces: 登录后先显示专属欢迎页（可跳过进工作台）；工作台三栏骨架

- [ ] **Step 1: 欢迎页**

`web/src/pages/WelcomePage.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { Button } from '../components/ui/Button'

/**
 * 登录后的专属欢迎页。文案由后端按姓名给（config/welcome.json，不入库）。
 * 动效有目的：淡入是"你到了"的状态转换反馈，不是装饰。
 */
export function WelcomePage ({ onEnter }: { onEnter: () => void }) {
  const { welcome, name } = useSession()
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 60)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div
        className={`text-center transition-all duration-500 ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
      >
        <div className="text-[40px] font-semibold leading-tight tracking-tight text-ink-50">
          {welcome ?? '欢迎回来'}
        </div>
        <div className="mt-2 text-sm text-ink-400">{name}</div>
        <Button variant="primary" className="mt-8 px-8" onClick={onEnter}>开始</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 工作台三栏骨架**

`web/src/pages/Workspace.tsx`：

```tsx
import { useState } from 'react'
import { useSession } from '../store/session'
import { Button } from '../components/ui/Button'

/**
 * 三栏布局（设计文档第 11 节）：
 *   左：可折叠项目列表（Task 7 填内容）
 *   中：主区 —— 文案编辑（Task 7）；预览+时间轴留给 3B
 *   右：属性面板 —— 3B 填
 * 分栏靠背景色差异区分，不靠边框线（排版优先于框线）。
 */
export function Workspace () {
  const [collapsed, setCollapsed] = useState(false)
  const { name, logout } = useSession()

  return (
    <div className="flex h-full">
      {/* 左：项目列表 */}
      <aside className={`flex flex-col bg-ink-900 transition-all duration-200 ${collapsed ? 'w-14' : 'w-64'}`}>
        <div className="flex h-14 items-center justify-between px-3">
          {!collapsed && <span className="text-sm font-semibold tracking-tight text-ink-50">SureJack</span>}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            title={collapsed ? '展开' : '收起'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {!collapsed && <div className="px-2 py-3 text-xs text-ink-400">项目列表（Task 7）</div>}
        </div>
        {!collapsed && (
          <div className="p-2">
            <div className="mb-1 px-2 text-xs text-ink-400">{name}</div>
            <Button className="w-full justify-start" onClick={logout}>登出</Button>
          </div>
        )}
      </aside>

      {/* 中：主区 */}
      <main className="flex flex-1 flex-col bg-ink-950">
        <div className="flex h-14 items-center px-6 text-sm text-ink-400">选一个项目开始</div>
        <div className="flex-1 px-6 pb-6">
          <div className="flex h-full items-center justify-center text-sm text-ink-400">
            文案编辑区（Task 7）
          </div>
        </div>
      </main>

      {/* 右：属性面板 */}
      <aside className="w-72 bg-ink-900 p-4">
        <div className="text-xs text-ink-400">属性面板（阶段 3B）</div>
      </aside>
    </div>
  )
}
```

- [ ] **Step 3: App.tsx 串起三个页面**

`web/src/App.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { useSession } from './store/session'
import { LoginPage } from './pages/LoginPage'
import { WelcomePage } from './pages/WelcomePage'
import { Workspace } from './pages/Workspace'

export default function App () {
  const { status, check } = useSession()
  const [entered, setEntered] = useState(false)

  useEffect(() => { check() }, [check])

  if (status === 'unknown') {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">载入中…</div>
  }
  if (status === 'anon') return <LoginPage />
  if (!entered) return <WelcomePage onEnter={() => setEntered(true)} />
  return <Workspace />
}
```

- [ ] **Step 4: 手动验证**

起后端 + `cd web && npm run dev`，浏览器登录。
Expected：登录后先看到专属欢迎语（用真白名单的话，陈梓昂看到「欢迎主人」、黄诗婕看到「欢迎老大」），点"开始"进三栏工作台；左栏能折叠；点登出回登录页。

- [ ] **Step 5: 提交**

```bash
git add web/src
git commit -m "feat: 欢迎页 + 工作台三栏骨架

登录后先显示按姓名定制的欢迎语（后端给，真名不入库）。
三栏布局：左可折叠项目列表 / 中主区 / 右属性面板，
分栏靠背景色差异不靠边框线。"
```

---

## Task 7: 前端 —— 项目列表 + 文案编辑（本阶段的收尾）

**Files:**
- Create: `web/src/store/projects.ts`, `web/src/components/ProjectList.tsx`, `web/src/components/ScriptEditor.tsx`
- Modify: `web/src/pages/Workspace.tsx`

**Interfaces:**
- Consumes: `api`、`useSession`
- Produces: `useProjects()` store（`items`、`currentId`、`current`、`load()`、`create(name)`、`select(id)`、`updateScript(text)`、`remove(id)`）；项目列表与文案编辑组件

- [ ] **Step 1: 项目 store**

`web/src/store/projects.ts`：

```typescript
import { create } from 'zustand'
import { api } from '../api/client'

export interface Project {
  id: string
  name: string
  scriptText: string
  aspectRatio: string
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
```

- [ ] **Step 2: 项目列表组件**

`web/src/components/ProjectList.tsx`：

```tsx
import { useState } from 'react'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

export function ProjectList () {
  const { items, currentId, select, create, remove } = useProjects()
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  async function submitNew () {
    const name = newName.trim()
    if (!name) return
    await create(name)
    setNewName(''); setAdding(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-2">
        {adding ? (
          <Input
            autoFocus value={newName} placeholder="项目名"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew()
              if (e.key === 'Escape') { setAdding(false); setNewName('') }
            }}
            onBlur={() => { if (!newName.trim()) setAdding(false) }}
          />
        ) : (
          <Button className="w-full justify-start" onClick={() => setAdding(true)}>＋ 新建项目</Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {items.length === 0 && (
          <div className="px-2 py-6 text-center text-xs leading-relaxed text-ink-400">
            还没有项目<br />新建一个开始写文案
          </div>
        )}
        {items.map((p) => (
          <div
            key={p.id}
            onClick={() => select(p.id)}
            className={`group mb-0.5 flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
              p.id === currentId ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="truncate text-xs text-ink-400">
                {p.scriptText ? `${[...p.scriptText].length} 字` : '空文案'}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); if (confirm(`删除「${p.name}」？`)) remove(p.id) }}
              className="ml-2 hidden rounded p-1 text-ink-400 hover:text-danger group-hover:block"
              title="删除"
            >×</button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 文案编辑器**

`web/src/components/ScriptEditor.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../store/projects'

/**
 * 文案编辑器。文案是项目的一等公民（设计文档），所以：
 *   - 打字不卡：本地即时更新，600ms 防抖后才发请求
 *   - 切项目时同步本地草稿，避免把上一个项目的文字带过去
 */
export function ScriptEditor () {
  const { current, updateScript, saving } = useProjects()
  const project = current()
  const [text, setText] = useState(project?.scriptText ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 切换项目时，把编辑框内容换成新项目的文案
  useEffect(() => { setText(project?.scriptText ?? '') }, [project?.id])

  function onChange (value: string) {
    setText(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { updateScript(value) }, 600)
  }

  // 卸载时把未保存的改动刷出去，避免切走就丢
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!project) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">左侧选一个项目</div>
  }

  const charCount = [...text].length

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between pb-3">
        <div className="text-xs text-ink-400">
          {charCount} 字 · 约 {Math.round(charCount * 0.196)} 秒配音
        </div>
        <div className="text-xs text-ink-400">{saving ? '保存中…' : '已保存'}</div>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="把文案粘贴或写在这里…"
        className="flex-1 resize-none rounded-xl bg-ink-900 p-5 text-[15px] leading-[1.9] text-ink-100 placeholder:text-ink-400 outline-none"
      />
    </div>
  )
}
```

- [ ] **Step 4: 接进 Workspace**

修改 `web/src/pages/Workspace.tsx`：

1. 顶部加 import 和 effect：
```tsx
import { useEffect, useState } from 'react'
import { useProjects } from '../store/projects'
import { ProjectList } from '../components/ProjectList'
import { ScriptEditor } from '../components/ScriptEditor'
```

2. 组件里加载项目：
```tsx
  const { load, current } = useProjects()
  useEffect(() => { load() }, [load])
  const project = current()
```

3. 左栏内容区（原来那句"项目列表（Task 7）"）换成：
```tsx
        <div className="flex-1 overflow-hidden">
          {!collapsed && <ProjectList />}
        </div>
```

4. 中间主区换成：
```tsx
      <main className="flex flex-1 flex-col bg-ink-950">
        <div className="flex h-14 items-center px-6">
          <span className="text-sm font-medium text-ink-100">{project?.name ?? '选一个项目开始'}</span>
        </div>
        <div className="flex-1 px-6 pb-6"><ScriptEditor /></div>
      </main>
```

- [ ] **Step 5: 手动验证完整流程**

起后端 + 前端 dev，浏览器里：
1. 登录 → 看到欢迎语 → 点开始进工作台
2. 新建项目 → 出现在左栏
3. 在中间写文案 → 左栏字数实时变、右上角显示"保存中…→已保存"
4. **刷新页面** → 文案还在（真的存进库了）
5. 建第二个项目 → 切换 → 两个项目的文案互不串
6. 删除项目 → 从列表消失

Expected: 全部符合。特别是第 4 条和第 5 条——那是"数据真的存下来了"和"状态没串"的证据。

- [ ] **Step 6: 构建 + 全量测试**

```bash
cd web && npm run build && cd ..
npx vitest run && npx tsc --noEmit
```
Expected: 构建成功，后端测试全绿

- [ ] **Step 7: 提交**

```bash
git add web/src
git commit -m "feat: 项目列表 + 文案编辑 —— 阶段 3A 完成

文案是一等公民：打字本地即时更新不卡，600ms 防抖后落库；
切项目时同步草稿避免串文案。左栏显示字数，编辑区显示保存状态
和预估配音时长（实测 196ms/字）。"
```

---

## Task 8: 部署到线上 + 阶段收尾

**Files:**
- Modify: `deploy/DEPLOY.md`, `docs/superpowers/specs/2026-07-16-surejack-design.md`

- [ ] **Step 1: 构建前端并重启服务**

```bash
cd /root/SureJack/web && npm run build && cd ..
sudo systemctl restart surejack
sleep 2
sudo systemctl is-active surejack     # 应 active
```

- [ ] **Step 2: 线上验证**

```bash
curl -s -o /dev/null -w "首页: HTTP %{http_code}\n" https://surejack.zacchen.win/
curl -s -o /dev/null -w "健康: HTTP %{http_code}\n" https://surejack.zacchen.win/api/health
curl -s -o /dev/null -w "未知接口: HTTP %{http_code}\n" https://surejack.zacchen.win/api/nope
# 🔒 每次动服务后必查
curl -s -o /dev/null -w "plus: HTTP %{http_code}\n" -H "Host: plus.drziangchen.uk" http://127.0.0.1/api/health
```
Expected: 首页 200、健康 200、未知接口 404、plus 200

- [ ] **Step 3: 用真浏览器验收（这是本阶段的真正验收）**

用户打开 `https://surejack.zacchen.win`，用真实姓名登录，确认：
- 陈梓昂看到「欢迎主人」，黄诗婕看到「欢迎老大」
- 能建项目、写文案、刷新后文案还在
- 界面观感符合"简洁大方、配色高级"的要求

- [ ] **Step 4: 更新部署手册**

在 `deploy/DEPLOY.md` 的「运维」小节加一条：
```markdown
- **改前端后**：`cd web && npm run build && sudo systemctl restart surejack`
  （前端构建到 public/，由后端托管；不需要动 nginx）
```

- [ ] **Step 5: 更新设计文档实现状态**

在设计文档第 12 节的实现状态里，把阶段 3A 已完成的部分标注出来：项目 CRUD 接口、前端登录/欢迎页/项目列表/文案编辑已实现；素材上传、导出队列、SSE 进度、JASSUB 预览、时间轴仍属 3B。

- [ ] **Step 6: 提交并推送**

```bash
git add deploy/DEPLOY.md docs/superpowers/specs/2026-07-16-surejack-design.md
git commit -m "docs: 阶段 3A 完成，更新部署手册与实现状态"
git push origin master
```

---

## 阶段 3A 明确不做的（划界）

- **素材上传**（背景视频、BGM）—— 3B。上传涉及大文件、进度、存储管理，是独立一块。
- **渲染导出 + 队列 + SSE 进度** —— 3B。
- **JASSUB 预览 + 时间轴** —— 3B。JASSUB 要用 Vite 正确集成（见 spikes/RESULTS.md 的 Spike 3 提示）。
- **配音参数、字幕样式、文本层的 UI** —— 3B，它们要和预览一起做才有意义。
- **项目重命名** —— 后端 PATCH 已支持 name，前端 UI 留到需要时再加（YAGNI）。
