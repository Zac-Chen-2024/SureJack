import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let dataDir = ''
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const LIST = ['测试选曲甲']

beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

/** 素材库指向临时目录——绝不碰真实的 data/library/（8.5GB） */
async function makeApp (): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-bgm-patch-'))
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
  if (!c) throw new Error('登录没拿到会话 cookie')
  return c.value
}

async function newProject (a: FastifyInstance, cookie: string): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name: '选曲项目' },
    cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

describe('PATCH /api/projects/:id —— bgmLibraryId', () => {
  it('能存下素材库 BGM 的 id', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试选曲甲')
    const id = await newProject(a, cookie)

    const res = await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { bgmLibraryId: 'lib-bgm-1' }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().bgmLibraryId).toBe('lib-bgm-1')

    const got = await a.inject({ method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie } })
    expect(got.json().bgmLibraryId).toBe('lib-bgm-1')
  })

  it('传 null 能清空选择——不是"忽略这个字段"', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试选曲甲')
    const id = await newProject(a, cookie)
    await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { bgmLibraryId: 'lib-bgm-1' }, cookies: { sj_session: cookie },
    })

    const res = await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { bgmLibraryId: null }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().bgmLibraryId).toBe(null)
  })

  it('不传该字段时保持原值', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试选曲甲')
    const id = await newProject(a, cookie)
    await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { bgmLibraryId: 'lib-bgm-1' }, cookies: { sj_session: cookie },
    })

    const res = await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { name: '换个名字' }, cookies: { sj_session: cookie },
    })
    expect(res.json().name).toBe('换个名字')
    expect(res.json().bgmLibraryId).toBe('lib-bgm-1')
  })

  it('非字符串非 null 的值被忽略，不写进库', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试选曲甲')
    const id = await newProject(a, cookie)

    const res = await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { bgmLibraryId: 12345 }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().bgmLibraryId).toBe(null)
  })
})
