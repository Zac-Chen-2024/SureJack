import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { BUCKETS, bucketDir } from '../../src/library/paths.js'

const exec = promisify(execFile)

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['素材库甲', '素材库乙']

/**
 * ⚠️ 【绝不扫真实素材库】。data/library/ 里是 8.5GB 真素材，
 * 单是 3-地铁跑酷 桶的 GB 级文件就够让测试跑到超时，而且扫描会往
 * 真实索引库 data/library/library.db 写数据——测试不该有那种副作用。
 * 所以整套用例跑在一个临时 dataDir 上，用 ffmpeg 现生成几十 KB 的小视频。
 */
let dataDir: string

async function makeVideo (path: string, seconds: number): Promise<void> {
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=64x64`,
    '-pix_fmt', 'yuv420p', path,
  ])
}

async function makeAudio (path: string, seconds: number): Promise<void> {
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=d=${seconds}`, path,
  ])
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-lib-routes-'))
  // 四个桶各放两个文件，桶名与真实素材包一致
  for (const b of BUCKETS) {
    const dir = bucketDir(dataDir, b)
    await mkdir(dir, { recursive: true })
    if (b === '背景音乐') {
      await makeAudio(join(dir, '一笑倾城 现言 甜文.mp3'), 1)
      await makeAudio(join(dir, '若梦 古言 虐文.mp3'), 1)
    } else {
      await makeVideo(join(dir, `${b}-a.mp4`), 1)
      await makeVideo(join(dir, `${b}-b.mp4`), 1)
    }
  }
}, 120_000)

afterAll(async () => { await rm(dataDir, { recursive: true, force: true }) })

async function makeApp (): Promise<FastifyInstance> {
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg',
    libraryDataDir: dataDir,
  })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  const c = res.cookies.find((x) => x.name === 'sj_session')
  if (!c) throw new Error(`登录失败：${res.statusCode} ${res.body}`)
  return c.value
}

describe('素材库接口 —— 鉴权', () => {
  it('未登录列桶返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/library/1-开头' })
    expect(res.statusCode).toBe(401)
  })

  it('未登录扫描返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/library/scan' })
    expect(res.statusCode).toBe(401)
  })

  it('未登录时连未知桶名也先挡在 401——不泄漏桶是否存在', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/library/不存在的桶' })
    expect(res.statusCode).toBe(401)
  })
})

describe('素材库接口 —— 扫描', () => {
  it('扫描把四个桶都入库，返回每桶条数', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    const res = await app.inject({ method: 'POST', url: '/api/library/scan', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)

    const body = res.json() as { scanned: Record<string, number> }
    // 契约：{ scanned: Record<string, number> }，四个桶都要出现
    expect(Object.keys(body.scanned).sort()).toEqual([...BUCKETS].sort())
    expect(BUCKETS.map((b) => body.scanned[b])).toEqual([2, 2, 2, 2])
  }, 60_000)

  it('重复扫描幂等：条数不变，id 也不变', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')

    await app.inject({ method: 'POST', url: '/api/library/scan', cookies: { sj_session: cookie } })
    const first = (await app.inject({
      method: 'GET', url: '/api/library/1-开头', cookies: { sj_session: cookie },
    })).json() as { items: { id: string }[] }

    const again = await app.inject({ method: 'POST', url: '/api/library/scan', cookies: { sj_session: cookie } })
    expect(again.json().scanned['1-开头']).toBe(2)

    const second = (await app.inject({
      method: 'GET', url: '/api/library/1-开头', cookies: { sj_session: cookie },
    })).json() as { items: { id: string }[] }

    expect(second.items.length).toBe(2)
    // id 稳定是硬要求：项目只存 id 引用，重扫换 id 会把所有引用打断
    expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id))
  }, 60_000)

  it('另一个用户扫出来看到的是同一份库——素材库全局公用，不按用户过滤', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '素材库甲')
    await app.inject({ method: 'POST', url: '/api/library/scan', cookies: { sj_session: cookieA } })
    const a = (await app.inject({
      method: 'GET', url: '/api/library/2-常规', cookies: { sj_session: cookieA },
    })).json() as { items: { id: string }[] }

    const cookieB = await loginAs(app, '素材库乙')
    const b = (await app.inject({
      method: 'GET', url: '/api/library/2-常规', cookies: { sj_session: cookieB },
    })).json() as { items: { id: string }[] }

    expect(b.items.length).toBe(2)
    expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id))
  }, 60_000)
})

describe('素材库接口 —— 列桶', () => {
  it('四个桶都能列出，字段符合契约', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    await app.inject({ method: 'POST', url: '/api/library/scan', cookies: { sj_session: cookie } })

    for (const b of BUCKETS) {
      const res = await app.inject({
        method: 'GET', url: `/api/library/${encodeURIComponent(b)}`, cookies: { sj_session: cookie },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: Record<string, unknown>[] }
      expect(body.items.length).toBe(2)
      // 契约字段一个不少、一个不多（noUncheckedIndexedAccess：整体 map 比对）
      expect(body.items.map((i) => Object.keys(i).sort().join(','))).toEqual([
        'bucket,durationMs,filename,id,sizeBytes',
        'bucket,durationMs,filename,id,sizeBytes',
      ])
      expect(body.items.map((i) => i.bucket)).toEqual([b, b])
      expect(body.items.map((i) => typeof i.filename === 'string' && (i.filename as string).length > 0))
        .toEqual([true, true])
      expect(body.items.map((i) => typeof i.durationMs === 'number' && (i.durationMs as number) > 0))
        .toEqual([true, true])
      expect(body.items.map((i) => typeof i.sizeBytes === 'number' && (i.sizeBytes as number) > 0))
        .toEqual([true, true])
    }
  }, 60_000)

  it('未扫描过的桶返回空数组，不是 404', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sj-lib-empty-'))
    const a = buildServer({
      authDbPath: ':memory:', whitelist: LIST,
      cookieSecret: 'test-secret-32-chars-long-abcdefg', libraryDataDir: empty,
    })
    await a.ready()
    app = a
    const cookie = await loginAs(app, '素材库甲')
    const res = await app.inject({ method: 'GET', url: '/api/library/1-开头', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [] })
    await rm(empty, { recursive: true, force: true })
  })

  it('未知桶名返回 400', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    const res = await app.inject({ method: 'GET', url: '/api/library/4-不存在', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().items).toBeUndefined()
  })

  it('🔒 穿越路径被拒——isBucket 是唯一一道闸', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    // 编码过的 ../ 会被 Fastify 解码成真正的路径参数，必须在 handler 里被白名单挡死
    const evil = [
      '%2e%2e%2f%2e%2e%2fetc',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2f陈梓昂',
      '..%2F..%2Fauth.db',
      '1-开头%2f..%2f..%2f陈梓昂',
      encodeURIComponent('/etc/passwd'),
      encodeURIComponent('1-开头 '),
    ]
    for (const p of evil) {
      const res = await app.inject({ method: 'GET', url: `/api/library/${p}`, cookies: { sj_session: cookie } })
      // 允许 400（白名单拒绝）或 404（路由压根没匹配上），但绝不能是 200
      expect([400, 404]).toContain(res.statusCode)
      expect(res.body.includes('library.db')).toBe(false)
    }
  })

  it('🔒 桶名大小写/前后空格不做清洗，一律按未知桶拒绝', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    for (const p of [' 1-开头', '1-开头 ', '1-开头/']) {
      const res = await app.inject({
        method: 'GET', url: `/api/library/${encodeURIComponent(p)}`, cookies: { sj_session: cookie },
      })
      expect([400, 404]).toContain(res.statusCode)
    }
  })

  it('scan 不会被当成桶名——POST 路由与 GET :bucket 不冲突', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '素材库甲')
    const res = await app.inject({ method: 'GET', url: '/api/library/scan', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)   // 'scan' 不是桶
  })
})
