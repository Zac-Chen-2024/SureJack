# SureJack 阶段 2：认证、数据隔离与部署 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给阶段 1 的生成管线套上一个安全、可登录、数据物理隔离的 HTTP 后端，并把它作为真实 HTTPS 服务部署到 `surejack.zacchen.win`。

**Architecture:** Fastify HTTP 服务 + 玩笑式白名单认证（真密码、真 HTTPS）+ 每个用户一个独立 SQLite 文件（物理隔离，非逻辑过滤）。**本阶段不做项目 CRUD 的业务接口**——那些接口的形状取决于前端需求，留到阶段 3 与前端一起做（YAGNI）。本阶段交付「可登录、可部署的安全地基」，并顺带解锁 Spike 3（JASSUB 真机验证需要真 HTTPS）。

**Tech Stack:** Node 24 LTS、Fastify、`@fastify/cookie`（签名会话）、`@fastify/rate-limit`（登录限流）、`better-sqlite3`（每用户一个库）、`node:crypto` 的 `scrypt`（密码哈希，**零额外原生依赖**）、nginx + certbot（部署）

## Global Constraints

以下每条都来自设计文档第 3、4、16 节，逐字照抄，违反即安全漏洞：

- **服务在公网上**（`surejack.zacchen.win`），认证的每一条要求都不是可选项。
- **白名单两个姓名**，硬编码在配置里，**不入库**。
- **首次登录设密码，之后凭密码进入**；名单外的姓名**拒绝登录，退回初始页**。
- **密码哈希用 `scrypt`（`node:crypto` 内置）**，绝不明文、绝不 MD5/SHA。
- **登录必须限流**——密码是唯一的门，不限流等于允许慢速爆破。
- **会话用签名 cookie**：`httpOnly` + `secure` + `sameSite=lax`。
- **HTTPS 强制**，HTTP 跳转到 HTTPS。
- **每个用户一个独立 SQLite 文件**：`data/<姓名>/app.db`；认证数据单独 `data/auth.db`。
- **隔离是物理性的**：代码里**不存在 `WHERE owner = ?`**，打开哪个库由会话身份决定。
- **姓名 → 数据库路径的映射必须先经过白名单校验再拼路径**——防路径穿越的第一道闸。
- **素材文件路径由会话身份拼出，绝不接受 URL 参数指定路径**。
- **首次设密码必须记日志**（时间 + 来源 IP）——抢注检测的唯一依据。
- **密码重置 CLI 必须实现**——忘记密码的唯一解，也是抢注风险被接受的前提。
- **绝不编辑 `/etc/nginx/sites-enabled/plus.drziangchen.uk`**——那是生产中的另一个服务。
- 域名：`surejack.zacchen.win` → `130.245.136.191`（Cloudflare DNS only，已验证；443 入站已验证可达）。
- Node 24 LTS（系统默认 20 已 EOL；开发用 nvm 装的 24）。

---

## ⚠️ 本计划分两部分，性质完全不同

- **Part A（Task 1–7）：纯代码。** 可由子代理自动化实现 + TDD + 评审，全程不碰服务器基础设施。产出一个能在本地起、能登录、数据隔离生效的 HTTP 服务。
- **Part B（Task 8–12）：生产基础设施。** **必须用户在场**——碰 nginx、certbot、systemd、防火墙，而这台机器上跑着 `plus` 生产站。**不能派子代理闷头做**，每一步都要人确认。这部分是 runbook（操作手册）风格，不是 TDD。

---

## 文件结构

```
src/
├── server.ts                 # Fastify app 工厂 + 启动入口
├── auth/
│   ├── whitelist.ts          # 白名单加载 + 姓名→库目录映射（防路径穿越）
│   ├── password.ts           # scrypt 哈希 + 验证（纯函数）
│   ├── session.ts            # 签名 cookie 装配 + requireAuth 守卫
│   └── routes.ts             # POST /api/login、/api/logout、GET /api/whoami
├── db/
│   ├── auth-db.ts            # data/auth.db —— 姓名→密码哈希、首登IP
│   └── user-db.ts            # data/<姓名>/app.db —— 由会话身份打开，建 schema
└── cli/
    └── reset-password.ts     # 重置指定姓名密码的命令行工具
tests/
├── auth/{whitelist,password,session,routes}.test.ts
└── db/{auth-db,user-db}.test.ts
deploy/
├── surejack.service          # systemd 单元文件
├── nginx-surejack.conf       # nginx server block（独立文件，不碰 plus）
└── DEPLOY.md                 # Part B 的完整操作手册
config/
└── whitelist.example.json    # 白名单模板（真名单不入库）
```

**为什么这样切**：`password.ts`（哈希纯函数）、`whitelist.ts`（路径映射纯函数）是安全关键且好测的核心。`auth-db.ts`/`user-db.ts` 碰 SQLite，用临时库测。`routes.ts` 用 Fastify 的 `inject()` 做集成测试，不需要真起网络。

---

# Part A —— 纯代码（可自动化）

## Task 1: Fastify 骨架 + 配置

**Files:**
- Create: `src/server.ts`, `config/whitelist.example.json`
- Modify: `package.json`
- Test: `tests/server.test.ts`

**Interfaces:**
- Produces: `buildServer(opts?): FastifyInstance`（app 工厂，供测试用 inject）；`loadWhitelist(): string[]`

- [ ] **Step 1: 装依赖**

```bash
source ~/.nvm/nvm.sh && nvm use 24
npm install fastify @fastify/cookie @fastify/rate-limit better-sqlite3
npm install -D @types/better-sqlite3
npm pkg set scripts.server="tsx src/server.ts"
npm pkg set scripts.reset-password="tsx src/cli/reset-password.ts"
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/server.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

describe('buildServer', () => {
  it('健康检查端点返回 200', async () => {
    app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 实现**

创建 `config/whitelist.example.json`：

```json
["示例姓名甲", "示例姓名乙"]
```

创建 `src/server.ts`：

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 加载白名单。真名单放 config/whitelist.json（不入库），
 * 缺失时回退到 example（仅供本地起服务，生产必须提供真名单）。
 */
export function loadWhitelist (): string[] {
  const root = join(__dirname, '..')
  for (const name of ['whitelist.json', 'whitelist.example.json']) {
    try {
      const raw = readFileSync(join(root, 'config', name), 'utf-8')
      const list = JSON.parse(raw)
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) return list
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 config/whitelist.json 或 whitelist.example.json')
}

export function buildServer (opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false })

  app.get('/api/health', async () => ({ status: 'ok' }))

  return app
}

// 直接运行时启动服务
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer({ logger: true })
  const port = Number(process.env.PORT ?? 8809)   // 避开 plus 的 8808
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`SureJack 后端监听 127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1) })
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/server.test.ts`
Expected: 1 passed

- [ ] **Step 6: 提交**

```bash
git add src/server.ts config/whitelist.example.json tests/server.test.ts package.json package-lock.json
git commit -m "feat: Fastify 骨架 + 白名单加载

后端监听 8809（避开 plus 生产站的 8808）。白名单从 config 加载，
真名单不入库。健康检查端点用 inject() 测试，不起真网络。"
```

---

## Task 2: 密码哈希（scrypt，纯函数）

**Files:**
- Create: `src/auth/password.ts`
- Test: `tests/auth/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`、`verifyPassword(plain: string, stored: string): Promise<boolean>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth/password.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/auth/password.js'

describe('password', () => {
  it('哈希后能验证通过', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', h)).toBe(true)
  })

  it('错误密码验证失败', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  it('同一密码两次哈希结果不同——盐随机', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    // 但两者都能验证通过
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('哈希串里不含明文密码', async () => {
    const h = await hashPassword('secret123')
    expect(h).not.toContain('secret123')
  })

  it('格式损坏的哈希串验证失败而非抛错', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/auth/password.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/auth/password.ts`：

```typescript
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

const KEYLEN = 64
const SALTLEN = 16

/**
 * 用 scrypt 哈希密码。格式：<saltHex>:<hashHex>。
 * scrypt 是 node 内置的抗暴力破解 KDF，无需任何原生依赖。
 * 绝不明文、绝不用 MD5/SHA——那些不是为存密码设计的。
 */
export async function hashPassword (plain: string): Promise<string> {
  const salt = randomBytes(SALTLEN)
  const derived = (await scryptAsync(plain, salt, KEYLEN)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * 验证密码。用 timingSafeEqual 做定时安全比较，防止时序侧信道攻击。
 * 任何格式异常都返回 false，绝不抛错——避免把"哈希坏了"和"密码错了"暴露给攻击者。
 */
export async function verifyPassword (plain: string, stored: string): Promise<boolean> {
  try {
    const [saltHex, hashHex] = stored.split(':')
    if (!saltHex || !hashHex) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const derived = (await scryptAsync(plain, salt, KEYLEN)) as Buffer
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/auth/password.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/auth/password.ts tests/auth/password.test.ts
git commit -m "feat: 密码哈希——scrypt + 随机盐 + 定时安全比较

scrypt 是 node 内置的抗暴力 KDF，零原生依赖。verifyPassword 用
timingSafeEqual 防时序侧信道，任何格式异常返回 false 不抛错。"
```

---

## Task 3: 白名单与姓名→库路径映射（防路径穿越）

**Files:**
- Create: `src/auth/whitelist.ts`
- Test: `tests/auth/whitelist.test.ts`

**Interfaces:**
- Consumes: `loadWhitelist` from `src/server.ts`
- Produces: `isWhitelisted(name: string, list: string[]): boolean`、`userDbDir(name: string, list: string[]): string`（返回该用户的数据目录绝对路径，**先校验白名单再拼路径**）

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth/whitelist.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { isWhitelisted, userDbDir } from '../../src/auth/whitelist.js'

const LIST = ['张三', '李四']

describe('isWhitelisted', () => {
  it('名单内返回 true', () => {
    expect(isWhitelisted('张三', LIST)).toBe(true)
  })
  it('名单外返回 false', () => {
    expect(isWhitelisted('王五', LIST)).toBe(false)
  })
  it('空字符串返回 false', () => {
    expect(isWhitelisted('', LIST)).toBe(false)
  })
})

describe('userDbDir —— 防路径穿越', () => {
  it('名单内用户返回其数据目录', () => {
    const dir = userDbDir('张三', LIST)
    expect(dir).toContain('张三')
    expect(dir).toMatch(/\/data\//)
  })

  it('名单外用户直接抛错，绝不返回路径', () => {
    expect(() => userDbDir('王五', LIST)).toThrow()
  })

  it('路径穿越尝试被白名单挡下——"../etc" 不在名单里', () => {
    // 关键：即便攻击者构造了穿越路径，它也过不了白名单校验
    expect(() => userDbDir('../../etc/passwd', LIST)).toThrow()
    expect(() => userDbDir('张三/../李四', LIST)).toThrow()
  })

  it('返回的路径在 data 目录之内，不会逃逸', () => {
    const dir = userDbDir('张三', LIST)
    const dataRoot = dir.split('/data/')[0] + '/data/'
    expect(dir.startsWith(dataRoot)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/auth/whitelist.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/auth/whitelist.ts`：

```typescript
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = resolve(join(__dirname, '..', '..', 'data'))

export function isWhitelisted (name: string, list: string[]): boolean {
  return name.length > 0 && list.includes(name)
}

/**
 * 返回某用户的数据目录绝对路径。
 *
 * ⚠️ 防路径穿越的核心：【先校验白名单，再拼路径】。
 * 因为姓名必须精确等于白名单里的某一项（includes 全等比较），
 * 任何 "../"、"张三/../李四" 之类的构造都不可能等于白名单项，
 * 于是在 isWhitelisted 这一步就被挡死，根本走不到拼路径。
 * 这是设计文档第 4 节说的"防路径穿越的第一道闸"。
 *
 * 额外再加一道保险：拼出的路径必须仍在 DATA_ROOT 之内。
 */
export function userDbDir (name: string, list: string[]): string {
  if (!isWhitelisted(name, list)) {
    throw new Error(`拒绝：姓名不在白名单内`)
  }
  const dir = resolve(join(DATA_ROOT, name))
  // 双保险：即便白名单里混进了危险字符，也不允许逃出 data 根目录
  if (!dir.startsWith(DATA_ROOT + '/') && dir !== DATA_ROOT) {
    throw new Error('拒绝：数据路径逃逸')
  }
  return dir
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/auth/whitelist.test.ts`
Expected: 8 passed

- [ ] **Step 5: 提交**

```bash
git add src/auth/whitelist.ts tests/auth/whitelist.test.ts
git commit -m "feat: 白名单 + 姓名→库路径映射，防路径穿越

先校验白名单（全等比较）再拼路径——任何 ../ 构造都不等于白名单项，
在校验这步就被挡死。额外加一道'路径必须在 data 根内'的保险。"
```

---

## Task 4: 认证数据库（auth.db）

**Files:**
- Create: `src/db/auth-db.ts`
- Test: `tests/db/auth-db.test.ts`

**Interfaces:**
- Consumes: `hashPassword`、`verifyPassword`
- Produces: `openAuthDb(path: string): AuthDb`，`AuthDb` 含 `hasPassword(name): boolean`、`setPassword(name, plain, ip): Promise<void>`、`checkPassword(name, plain): Promise<boolean>`、`getFirstLoginInfo(name): {createdAt, ip} | null`、`close()`

- [ ] **Step 1: 写失败的测试**

创建 `tests/db/auth-db.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { openAuthDb, type AuthDb } from '../../src/db/auth-db.js'

let db: AuthDb
afterEach(() => db?.close())

describe('auth-db', () => {
  it('新用户没有密码', () => {
    db = openAuthDb(':memory:')
    expect(db.hasPassword('张三')).toBe(false)
  })

  it('设密码后 hasPassword 为真，且能验证', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw123', '1.2.3.4')
    expect(db.hasPassword('张三')).toBe(true)
    expect(await db.checkPassword('张三', 'pw123')).toBe(true)
    expect(await db.checkPassword('张三', 'wrong')).toBe(false)
  })

  it('首次设密码记录时间和 IP——抢注检测依据', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw', '9.9.9.9')
    const info = db.getFirstLoginInfo('张三')
    expect(info?.ip).toBe('9.9.9.9')
    expect(info?.createdAt).toBeTruthy()
  })

  it('重置密码不改写首登记录——首登 IP 是原始证据', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw1', '1.1.1.1')
    const first = db.getFirstLoginInfo('张三')
    await db.setPassword('张三', 'pw2', '2.2.2.2')   // 重置
    expect(await db.checkPassword('张三', 'pw2')).toBe(true)
    expect(db.getFirstLoginInfo('张三')?.ip).toBe('1.1.1.1')  // 首登 IP 不变
  })

  it('未设密码的用户 checkPassword 为 false，不抛错', async () => {
    db = openAuthDb(':memory:')
    expect(await db.checkPassword('查无此人', 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/db/auth-db.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/db/auth-db.ts`：

```typescript
import Database from 'better-sqlite3'
import { hashPassword, verifyPassword } from '../auth/password.js'

export interface AuthDb {
  hasPassword (name: string): boolean
  setPassword (name: string, plain: string, ip: string): Promise<void>
  checkPassword (name: string, plain: string): Promise<boolean>
  getFirstLoginInfo (name: string): { createdAt: string; ip: string } | null
  close (): void
}

/**
 * 打开认证库。这是唯一的共享库——只存密码哈希，不含任何项目数据。
 * 密码重置 CLI 也只碰这一个文件。
 */
export function openAuthDb (path: string): AuthDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      first_login_ip TEXT NOT NULL
    )
  `)

  return {
    hasPassword (name) {
      return db.prepare('SELECT 1 FROM users WHERE name = ?').get(name) !== undefined
    },

    async setPassword (name, plain, ip) {
      const hash = await hashPassword(plain)
      const existing = db.prepare('SELECT created_at, first_login_ip FROM users WHERE name = ?').get(name) as
        { created_at: string; first_login_ip: string } | undefined
      if (existing) {
        // 重置：只改哈希，保留首登记录（首登 IP 是抢注证据）
        db.prepare('UPDATE users SET password_hash = ? WHERE name = ?').run(hash, name)
      } else {
        // 首次：记录时间和 IP。用 ISO 字符串（Date 在测试里可用，非生产热路径）
        const now = new Date().toISOString()
        db.prepare('INSERT INTO users (name, password_hash, created_at, first_login_ip) VALUES (?, ?, ?, ?)')
          .run(name, hash, now, ip)
      }
    },

    async checkPassword (name, plain) {
      const row = db.prepare('SELECT password_hash FROM users WHERE name = ?').get(name) as
        { password_hash: string } | undefined
      if (!row) return false
      return verifyPassword(plain, row.password_hash)
    },

    getFirstLoginInfo (name) {
      const row = db.prepare('SELECT created_at, first_login_ip FROM users WHERE name = ?').get(name) as
        { created_at: string; first_login_ip: string } | undefined
      return row ? { createdAt: row.created_at, ip: row.first_login_ip } : null
    },

    close () { db.close() },
  }
}
```

> **注意**：`new Date().toISOString()` 在生产热路径里被 Claude 的运行时禁用，但这是服务端 Node 进程运行时的真实代码，不是 Claude 工具内执行的脚本——所以没问题。测试用 `:memory:` 库，也不受影响。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/db/auth-db.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/db/auth-db.ts tests/db/auth-db.test.ts
git commit -m "feat: 认证库 auth.db——密码哈希 + 首登IP记录

首登记录时间和 IP（抢注检测依据），重置密码不改写它。
这是唯一的共享库，只存哈希，不含项目数据。"
```

---

## Task 5: 每用户数据库（物理隔离）

**Files:**
- Create: `src/db/user-db.ts`
- Test: `tests/db/user-db.test.ts`

**Interfaces:**
- Consumes: `userDbDir` from `src/auth/whitelist.ts`
- Produces: `openUserDb(name: string, whitelist: string[]): UserDb`（**只接受姓名 + 白名单，路径在内部拼，外部无法指定**），`UserDb` 含 `raw: Database`（供阶段 3 建 CRUD）、`path: string`、`close()`

- [ ] **Step 1: 写失败的测试**

创建 `tests/db/user-db.test.ts`：

```typescript
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'
import { rmSync } from 'node:fs'

const LIST = ['张三', '李四']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

describe('user-db —— 物理隔离', () => {
  it('打开的库路径包含用户名', () => {
    const db = openUserDb('张三', LIST); dbs.push(db)
    expect(db.path).toContain('张三')
  })

  it('两个用户的库是不同文件——物理隔离', () => {
    const a = openUserDb('张三', LIST); dbs.push(a)
    const b = openUserDb('李四', LIST); dbs.push(b)
    expect(a.path).not.toBe(b.path)
  })

  it('名单外用户无法打开库——路径映射先过白名单', () => {
    expect(() => openUserDb('王五', LIST)).toThrow()
  })

  it('外部无法通过参数指定任意路径——签名里根本没有 path 参数', () => {
    // 这是类型层面的保证：openUserDb 只收 name + whitelist。
    // 这个测试确认调用契约——路径由 name 经白名单映射得出，不可注入。
    const db = openUserDb('张三', LIST); dbs.push(db)
    expect(db.path.endsWith('app.db')).toBe(true)
  })

  it('建好了 projects 表（schema 就位，CRUD 留给阶段3）', () => {
    const db = openUserDb('张三', LIST); dbs.push(db)
    const tbl = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()
    expect(tbl).toBeTruthy()
  })
})
```

> 测试会在真实 `data/张三/` 下建库。测试结束 `afterEach` 关闭；`data/` 已在 `.gitignore` 里，不会误提交。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/db/user-db.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/db/user-db.ts`：

```typescript
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { userDbDir } from '../auth/whitelist.js'

export interface UserDb {
  raw: Database.Database
  path: string
  close (): void
}

/**
 * 打开某用户的独立数据库。
 *
 * ⚠️ 物理隔离的核心：函数签名【只收 name + 白名单】，绝不收 path。
 * 打开哪个文件由 userDbDir(name) 经白名单映射唯一确定，外部无法注入路径。
 * 这就是为什么整个项目里【不存在 WHERE owner = ?】——打开的库本身就是那个人的，
 * "某处查询忘了加过滤"这类泄露在结构上不可能发生（设计文档第 3 节）。
 *
 * schema 按设计文档第 4 节建好（projects 等表），但 CRUD 留给阶段 3
 * 与前端一起做——现在建 CRUD 是在凭空猜前端需要什么。
 */
export function openUserDb (name: string, whitelist: string[]): UserDb {
  const dir = userDbDir(name, whitelist)   // 先过白名单，防路径穿越
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'app.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  // schema：设计文档第 4 节。CRUD 留给阶段 3。
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

  return { raw: db, path, close () { db.close() } }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/db/user-db.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/db/user-db.ts tests/db/user-db.test.ts
git commit -m "feat: 每用户独立库——物理隔离

openUserDb 只收 name + 白名单，绝不收 path——路径由白名单映射唯一确定，
外部无法注入。这就是为什么全项目不存在 WHERE owner=？。
schema 按设计第4节建好，CRUD 留给阶段3与前端一起做。"
```

---

## Task 6: 会话与 requireAuth 守卫

**Files:**
- Create: `src/auth/session.ts`
- Modify: `src/server.ts`（注册 cookie 插件）
- Test: `tests/auth/session.test.ts`

**Interfaces:**
- Consumes: `@fastify/cookie`
- Produces: `registerSession(app, secret)`（装配签名 cookie）、`setSession(reply, name)`、`getSession(request): string | null`、`requireAuth(request, reply)`（Fastify preHandler 守卫）

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth/session.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerSession, setSession, getSession, requireAuth } from '../../src/auth/session.js'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

async function makeApp () {
  const a = Fastify()
  await registerSession(a, 'test-secret-at-least-32-chars-long!!')
  a.post('/login-as', async (req, reply) => {
    setSession(reply, '张三')
    return { ok: true }
  })
  a.get('/whoami', async (req) => ({ name: getSession(req) }))
  a.get('/protected', { preHandler: requireAuth }, async (req) => ({ name: getSession(req) }))
  await a.ready()
  return a
}

describe('session', () => {
  it('未登录时 getSession 返回 null', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/whoami' })
    expect(res.json()).toEqual({ name: null })
  })

  it('登录后 cookie 带上，getSession 返回姓名', async () => {
    app = await makeApp()
    const login = await app.inject({ method: 'POST', url: '/login-as' })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')
    expect(cookie).toBeTruthy()
    const who = await app.inject({ method: 'GET', url: '/whoami', cookies: { sj_session: cookie!.value } })
    expect(who.json()).toEqual({ name: '张三' })
  })

  it('requireAuth 挡下未登录请求，返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('requireAuth 放行已登录请求', async () => {
    app = await makeApp()
    const login = await app.inject({ method: 'POST', url: '/login-as' })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/protected', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: '张三' })
  })

  it('篡改的 cookie 被签名校验挡下——getSession 返回 null', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/whoami', cookies: { sj_session: '张三.伪造签名' } })
    expect(res.json()).toEqual({ name: null })
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/auth/session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/auth/session.ts`：

```typescript
import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const COOKIE_NAME = 'sj_session'

/**
 * 装配签名 cookie。secret 用于对 cookie 值做 HMAC 签名，
 * 篡改的 cookie 会被 unsign 判为无效——这是会话不可伪造的根基。
 */
export async function registerSession (app: FastifyInstance, secret: string): Promise<void> {
  await app.register(cookie, { secret })
}

/** 登录成功后写会话 cookie：httpOnly + secure + sameSite=lax（设计文档第3节） */
export function setSession (reply: FastifyReply, name: string): void {
  reply.setCookie(COOKIE_NAME, name, {
    signed: true,
    httpOnly: true,
    secure: true,        // 只在 HTTPS 下发送——生产是 HTTPS
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,   // 30 天
  })
}

/** 从请求里取出已验证的会话姓名；无 cookie 或签名无效返回 null */
export function getSession (request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE_NAME]
  if (!raw) return null
  const result = request.unsignCookie(raw)
  return result.valid ? result.value : null
}

/** 清除会话 */
export function clearSession (reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' })
}

/** Fastify preHandler 守卫：未登录返回 401 */
export async function requireAuth (request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (getSession(request) === null) {
    await reply.code(401).send({ error: '请先登录' })
  }
}
```

> **测试注意**：测试里 `secure: true` 的 cookie 在 `inject()` 的非 HTTPS 环境下，Fastify 仍会在响应里设置它（inject 不强制 HTTPS 语义），所以测试能拿到 cookie。生产 HTTPS 下 `secure` 才真正生效。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/auth/session.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/auth/session.ts tests/auth/session.test.ts
git commit -m "feat: 签名 cookie 会话 + requireAuth 守卫

cookie 用 secret 做 HMAC 签名，篡改会被 unsign 挡下。
httpOnly+secure+sameSite=lax。requireAuth 挡未登录请求返回 401。"
```

---

## Task 7: 登录路由 + 密码重置 CLI（Part A 收尾）

**Files:**
- Create: `src/auth/routes.ts`, `src/cli/reset-password.ts`
- Modify: `src/server.ts`（挂载 auth 路由 + 限流 + 会话）
- Test: `tests/auth/routes.test.ts`

**Interfaces:**
- Consumes: 前面全部
- Produces: `registerAuthRoutes(app, deps)`；服务完整可登录

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth/routes.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

// buildServer 支持注入内存 authDb 和白名单用于测试
async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: ['张三', '李四'] })
  await a.ready()
  return a
}

describe('登录流程', () => {
  it('名单外姓名被拒', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '王五', password: 'x' } })
    expect(res.statusCode).toBe(403)
  })

  it('名单内首次登录——设置密码并登入', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'first-pw' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '张三', firstLogin: true })
    expect(res.cookies.find((c) => c.name === 'sj_session')).toBeTruthy()
  })

  it('第二次用正确密码登入', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '张三', firstLogin: false })
  })

  it('第二次用错误密码被拒 401', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'wrong' } })
    expect(res.statusCode).toBe(401)
  })

  it('whoami 未登录返回 null，登录后返回姓名', async () => {
    app = await makeApp()
    const anon = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(anon.json()).toEqual({ name: null })
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '李四', password: 'pw' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const who = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(who.json()).toEqual({ name: '李四' })
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/auth/routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 routes.ts**

创建 `src/auth/routes.ts`：

```typescript
import type { FastifyInstance } from 'fastify'
import type { AuthDb } from '../db/auth-db.js'
import { isWhitelisted } from './whitelist.js'
import { setSession, getSession, clearSession } from './session.js'

interface Deps { authDb: AuthDb; whitelist: string[] }

/**
 * 挂载登录/登出/whoami。
 *
 * 登录流程（设计文档第 3 节）：
 *   - 名单外 → 403 拒绝
 *   - 名单内 + 未设密码 → 设密码并登入（首登，记 IP）
 *   - 名单内 + 已设密码 → 验证，对则登入，错则 401
 */
export function registerAuthRoutes (app: FastifyInstance, deps: Deps): void {
  const { authDb, whitelist } = deps

  app.post<{ Body: { name?: string; password?: string } }>('/api/login', async (req, reply) => {
    const name = req.body?.name?.trim() ?? ''
    const password = req.body?.password ?? ''

    if (!isWhitelisted(name, whitelist)) {
      return reply.code(403).send({ error: '你谁啊' })
    }
    if (!password) {
      return reply.code(400).send({ error: '请输入密码' })
    }

    const ip = req.ip
    if (!authDb.hasPassword(name)) {
      // 首次登录：设密码（记 IP 供抢注检测）
      await authDb.setPassword(name, password, ip)
      setSession(reply, name)
      return { name, firstLogin: true }
    }

    if (await authDb.checkPassword(name, password)) {
      setSession(reply, name)
      return { name, firstLogin: false }
    }
    return reply.code(401).send({ error: '密码错误' })
  })

  app.post('/api/logout', async (_req, reply) => {
    clearSession(reply)
    return { ok: true }
  })

  app.get('/api/whoami', async (req) => ({ name: getSession(req) }))
}
```

- [ ] **Step 4: 改 server.ts 挂载全部**

把 `src/server.ts` 的 `buildServer` 改成接受测试注入、并装配限流/会话/路由：

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerSession } from './auth/session.js'
import { registerAuthRoutes } from './auth/routes.js'
import { openAuthDb } from './db/auth-db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function loadWhitelist (): string[] {
  const root = join(__dirname, '..')
  for (const name of ['whitelist.json', 'whitelist.example.json']) {
    try {
      const raw = readFileSync(join(root, 'config', name), 'utf-8')
      const list = JSON.parse(raw)
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) return list
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 config/whitelist.json 或 whitelist.example.json')
}

interface BuildOpts {
  logger?: boolean
  authDbPath?: string
  whitelist?: string[]
  cookieSecret?: string
}

export function buildServer (opts: BuildOpts = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true })
  const whitelist = opts.whitelist ?? loadWhitelist()
  const authDb = openAuthDb(opts.authDbPath ?? join(__dirname, '..', 'data', 'auth.db'))
  const secret = opts.cookieSecret ?? process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex')

  app.get('/api/health', async () => ({ status: 'ok' }))

  // 装配（register 是异步的，但 Fastify 会在 ready() 时按序完成）
  app.register(async (scope) => {
    await registerSession(scope, secret)
    // 登录限流：每 IP 每分钟最多 10 次尝试。密码是唯一的门，必须挡爆破。
    await scope.register(rateLimit, {
      max: 10, timeWindow: '1 minute',
      allowList: [],   // 生产可加内网白名单
    })
    registerAuthRoutes(scope, { authDb, whitelist })
  })

  app.addHook('onClose', async () => authDb.close())
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.COOKIE_SECRET) {
    console.error('⚠️  生产必须设 COOKIE_SECRET 环境变量（否则重启后所有会话失效）')
  }
  const app = buildServer({ logger: true })
  const port = Number(process.env.PORT ?? 8809)
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`SureJack 后端监听 127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1) })
}
```

- [ ] **Step 5: 运行 routes 测试，确认通过**

Run: `npx vitest run tests/auth/routes.test.ts`
Expected: 5 passed

- [ ] **Step 6: 实现密码重置 CLI**

创建 `src/cli/reset-password.ts`：

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAuthDb } from '../db/auth-db.js'
import { loadWhitelist } from '../server.js'
import { isWhitelisted } from '../auth/whitelist.js'

/**
 * 重置指定姓名的密码。
 *
 * 这是【必需品】（设计文档第 3 节）：
 *   - 忘记密码的唯一解（没有邮箱验证/找回流程）
 *   - "被抢注了就在后端重置"这个兜底方案成立的前提
 *
 * 用法：npm run reset-password -- --name 张三
 * 然后按提示输入新密码（不走命令行参数，避免密码进 shell 历史）。
 */
async function main () {
  const { values } = parseArgs({ options: { name: { type: 'string' } } })
  const name = values.name?.trim()
  if (!name) {
    console.error('用法：npm run reset-password -- --name <姓名>')
    process.exit(1)
  }

  const whitelist = loadWhitelist()
  if (!isWhitelisted(name, whitelist)) {
    console.error(`❌ "${name}" 不在白名单里。白名单：${whitelist.join('、')}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const pw = await rl.question(`为 "${name}" 设置新密码：`)
  rl.close()
  if (pw.length < 4) { console.error('❌ 密码太短'); process.exit(1) }

  const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'auth.db')
  const db = openAuthDb(dbPath)
  await db.setPassword(name, pw, '127.0.0.1(cli-reset)')
  db.close()
  console.log(`✅ 已重置 "${name}" 的密码`)
}

main().catch((e) => { console.error('❌', e instanceof Error ? e.message : e); process.exit(1) })
```

- [ ] **Step 7: 全量测试 + 手动验证 CLI**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿 + 类型干净

手动验证服务能起、能登录：
```bash
COOKIE_SECRET=test node --import tsx src/server.ts &
sleep 2
curl -s -X POST localhost:8809/api/login -H 'Content-Type: application/json' -d '{"name":"示例姓名甲","password":"pw"}'
# 期望：{"name":"示例姓名甲","firstLogin":true}
curl -s -X POST localhost:8809/api/login -H 'Content-Type: application/json' -d '{"name":"黑客","password":"x"}'
# 期望：{"error":"你谁啊"}  （HTTP 403）
kill %1
```

- [ ] **Step 8: 提交**

```bash
git add src/auth/routes.ts src/cli/reset-password.ts src/server.ts tests/auth/routes.test.ts
git commit -m "feat: 登录路由 + 密码重置 CLI —— Part A 完成

登录流程：名单外403、名单内首登设密码记IP、之后验证密码。
登录限流每IP每分钟10次挡爆破。reset-password CLI 是忘密码的唯一解，
密码走交互输入不进 shell 历史。"
```

**Part A 到此结束——服务可登录、数据物理隔离、全部有测试。以下 Part B 需要用户在场。**

---

# Part B —— 生产基础设施（需用户在场，非子代理任务）

> **这一整部分不是 TDD，是 runbook。** 每一步碰真实服务器，而这台机器上跑着 `plus` 生产站。
> **执行原则**：每一步做完确认无误再下一步；任何碰 nginx 的操作前后都验证 `plus` 仍健康；
> `sudo` 会弹权限框（我们故意配的），那是让你有机会喊停。
> 这些内容也写进 `deploy/DEPLOY.md` 供将来复现。

## Task 8: 系统级 Node 24 + 构建 + systemd 服务

- [ ] **Step 1: 确认系统 Node**。开发用的是 nvm 的 24，但 systemd 服务要用一个稳定的系统级 Node 路径。决定：用 nvm 装的 24 的绝对路径（`~/.nvm/versions/node/v24.x/bin/node`），或给 root 装系统级 Node 24。**这一步需要和用户确认走哪条**（涉及 root 环境）。
- [ ] **Step 2: 生成持久的 `COOKIE_SECRET`**：`openssl rand -hex 32`，存进 `/root/SureJack/.env`（已 gitignore）。**丢了这个值 = 所有人被登出**。
- [ ] **Step 3: 准备真白名单**：创建 `config/whitelist.json`（不入库），填两个真实姓名。**问用户要这两个名字**（一直悬着没定）。
- [ ] **Step 4: 写 systemd 单元** `deploy/surejack.service`（监听 127.0.0.1:8809，`Environment=COOKIE_SECRET=...` 从 EnvironmentFile 读，`Restart=always`）。**装到 `/etc/systemd/system/` 需要 sudo，会弹框。**
- [ ] **Step 5: 启用并启动**：`systemctl enable --now surejack`，确认 `systemctl status surejack` 是 active，`curl localhost:8809/api/health` 返回 ok。

## Task 9: nginx server block（绝不碰 plus）

- [ ] **Step 1: 写 `deploy/nginx-surejack.conf`**：一个**独立**的 server block，`server_name surejack.zacchen.win`，反代 `127.0.0.1:8809`。**关键：`client_max_body_size` 要设大**（背景视频上传，比如 500M）——这台 nginx 默认值会挡住大上传。
- [ ] **Step 2: 装到 `/etc/nginx/sites-available/` 并软链到 `sites-enabled/`（sudo，弹框）**。**绝不编辑 plus 那个文件。**
- [ ] **Step 3: `nginx -t` 测试配置**，通过再 `systemctl reload nginx`（reload 不中断现有连接，plus 不掉线）。
- [ ] **Step 4: 立刻验证 plus 仍健康**：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8808/api/health` 应为 200。

## Task 10: HTTPS 证书（certbot / Let's Encrypt）

- [ ] **Step 1: 装 certbot**（`sudo apt-get install certbot python3-certbot-nginx`，弹框）。
- [ ] **Step 2: 签证书**。用 `certbot certonly --webroot`（不是 `--nginx`，避免 certbot 自动改我们的配置）或 `--standalone` 前先确认不冲突。**HTTP-01 挑战走 80 端口（已验证可达）**。域名 `surejack.zacchen.win`。
- [ ] **Step 3: 在 nginx server block 里启用 443 + 证书路径 + HTTP 强制跳 HTTPS**，`nginx -t` + `reload`。
- [ ] **Step 4: 确认自动续期**：`systemctl status certbot.timer`（certbot 装好会自带续期定时器）。

## Task 11: 上线冒烟测试 + 关闭抢注窗口

- [ ] **Step 1: 从外部（手机蜂窝数据 / check-host）访问 `https://surejack.zacchen.win/api/health`**，确认 HTTPS 通、证书有效。
- [ ] **Step 2: 【立刻】用 reset-password CLI 给两个人各设密码**：`npm run reset-password -- --name <姓名>`。这一步**关闭抢注窗口**（设计文档第 3 节的上线检查项）——在任何人能访问登录页之前把密码占掉。
- [ ] **Step 3: 端到端登录测试**：从外部 POST /api/login，确认能登入、cookie 是 secure、错误密码被限流。
- [ ] **Step 4: 确认 plus 生产站全程无恙**：`https://plus.drziangchen.uk` 仍正常。

## Task 12: 解锁 Spike 3（JASSUB 真机验证）+ 部署文档

- [ ] **Step 1: 既然有了真 HTTPS，把阶段 0 欠下的 Spike 3 做掉**：临时挂一个 JASSUB 测试页到 `surejack.zacchen.win` 下，**用户在真手机/真浏览器**打开，肉眼确认卡拉OK字幕渲染正常、且和 ffmpeg 烧录结果一致。这验证了「两端同一个 libass」的核心架构主张——阶段 3 前端预览就靠它。结论写进 `docs/superpowers/spikes/RESULTS.md`。
- [ ] **Step 2: 把 Part B 的实际操作整理进 `deploy/DEPLOY.md`**（含真实用到的命令、证书路径、systemd 服务名、续期确认），供将来重装或迁移复现。
- [ ] **Step 3: 提交部署产物**（`deploy/*.service`、`deploy/*.conf` 模板、`DEPLOY.md`；**不含** `.env`、`whitelist.json`、证书）。
- [ ] **Step 4: 更新设计文档第 12、16 节的实现状态**：auth/db/queue 标记已实现（queue 仍留阶段3），部署标记完成。

---

## 阶段 2 明确不做的（划界）

- **项目 CRUD 的 HTTP 接口**（建/改/删项目、上传素材、触发渲染、SSE 进度）—— 形状取决于前端需求，留阶段 3 与前端一起做，避免凭空猜错。
- **导出队列（`queue/`）** —— 同上，触发渲染的接口和队列一起在阶段 3 做。
- **`db/user-db.ts` 的完整 schema 和 CRUD** —— 本阶段只建 projects 骨架表证明隔离机制，其余表和读写留阶段 3。
- **真实认证之外的花活**（邮箱验证、找回流程、2FA）—— 设计文档第 17 节已拒绝，reset CLI 是全部答案。
