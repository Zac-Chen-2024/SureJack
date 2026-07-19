import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'

let app: FastifyInstance
let dataDir: string
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const LIST = ['排布甲', '排布乙']

// 与 tests/projects/routes.test.ts 同一套路：openUserDb 打开的是真实落盘的库，
// 用例之间会互相看到对方建的项目，所以每条用例前清空 projects 表。
beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

function insert (db: LibraryDb, bucket: string, filename: string, durationMs: number): void {
  db.raw.prepare(
    `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${bucket}/${filename}`, bucket, filename, durationMs, 1000, '2026-07-19T00:00:00.000Z')
}

/**
 * ⚠️ 素材库指向【临时目录】，绝不碰真实的 data/library/（8.5GB，
 * 扫一遍要几百次 ffprobe）。这里连 ffmpeg 都不用起，直接插索引行。
 */
async function makeApp (opts: { seedLibrary?: boolean } = {}): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-bgplan-'))
  if (opts.seedLibrary !== false) {
    const lib = openLibraryDb(dataDir)
    for (let i = 0; i < 20; i++) insert(lib, '1-开头', `开头-${String(i).padStart(2, '0')}.mp4`, 1000)
    for (let i = 0; i < 20; i++) insert(lib, '2-常规', `常规-${String(i).padStart(2, '0')}.mp4`, 1000)
    for (let i = 0; i < 3; i++) insert(lib, '3-地铁跑酷', `跑酷-${i}.mp4`, 600_000)
    lib.close()
  }
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg', libraryDataDir: dataDir,
  })
  await a.ready()
  app = a
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  const c = res.cookies.find((x) => x.name === 'sj_session')
  if (!c) throw new Error(`登录失败：${res.statusCode} ${res.body}`)
  return c.value
}

async function makeProject (a: FastifyInstance, cookie: string, name: string): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name }, cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

/** 直接改库把配音标成已就绪——不去真调 Azure */
function setTtsDuration (owner: string, projectId: string, durationMs: number): void {
  const db = openUserDb(owner, LIST)
  db.updateProject(projectId, { ttsState: 'ready', ttsDurationMs: durationMs })
  db.close()
}

describe('GET /api/projects/:id/background-plan', () => {
  it('未登录返回 401', async () => {
    const a = await makeApp()
    const res = await a.inject({ method: 'GET', url: '/api/projects/whatever/background-plan' })
    expect(res.statusCode).toBe(401)
  })

  it('项目不存在返回 404', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '排布甲')
    const res = await a.inject({
      method: 'GET', url: '/api/projects/没这个项目/background-plan', cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('配音未就绪返回空排布，而【不是 404】', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '排布甲')
    const id = await makeProject(a, cookie, '还没配音')
    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ segments: [], totalMs: 0 })
  })

  it('配音就绪后返回排布，字段符合契约', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '排布甲')
    const id = await makeProject(a, cookie, '有配音')
    setTtsDuration('排布甲', id, 47_123)

    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { segments: Record<string, unknown>[]; totalMs: number }
    expect(body.totalMs).toBe(47_123)
    expect(body.segments.length > 0).toBe(true)
    const keySets = body.segments.map((s) => Object.keys(s).sort().join(','))
    expect(new Set(keySets).size).toBe(1)
    expect(keySets[0]).toBe('bucket,filename,itemId,startMs,takeMs')
    // 片段之和必须精确等于配音总长，否则成片结尾会黑一帧
    expect(body.segments.reduce((s, x) => s + (x.takeMs as number), 0)).toBe(47_123)
  })

  it('同一个项目反复请求，返回完全一致——预览条不会刷一次变一次', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '排布甲')
    const id = await makeProject(a, cookie, '确定性')
    setTtsDuration('排布甲', id, 47_123)

    const get = async () => (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json()
    const first = await get()
    for (let i = 0; i < 5; i++) expect(await get()).toEqual(first)
  })

  it('两个项目拿到不同的素材组合', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '排布甲')
    const id1 = await makeProject(a, cookie, '项目一')
    const id2 = await makeProject(a, cookie, '项目二')
    setTtsDuration('排布甲', id1, 47_123)
    setTtsDuration('排布甲', id2, 47_123)

    const get = async (id: string) => (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json() as { segments: { itemId: string }[] }

    const p1 = await get(id1)
    const p2 = await get(id2)
    expect(p1.segments.map((s) => s.itemId)).not.toEqual(p2.segments.map((s) => s.itemId))
  })

  it('素材库还没扫过时返回 409，而不是 500——运维要能看出该去扫库', async () => {
    const a = await makeApp({ seedLibrary: false })
    const cookie = await loginAs(a, '排布甲')
    const id = await makeProject(a, cookie, '空库')
    setTtsDuration('排布甲', id, 47_123)

    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(409)
    expect(typeof res.json().error).toBe('string')
  })

  it('🔒 拿别人的项目 id 取排布也是 404——库都不是同一个', async () => {
    const a = await makeApp()
    const cookieA = await loginAs(a, '排布甲')
    const idA = await makeProject(a, cookieA, '甲的项目')
    setTtsDuration('排布甲', idA, 47_123)

    const cookieB = await loginAs(a, '排布乙')
    const res = await a.inject({
      method: 'GET', url: `/api/projects/${idA}/background-plan`, cookies: { sj_session: cookieB },
    })
    expect(res.statusCode).toBe(404)
  })
})
