import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { parseOpeningPick } from '../../src/library/background.js'

/*
 * 【定长开头】：开头段必须正好铺满到 head_boundary_ms。
 *
 * 为什么要定长——只有分界固定，后半段才能在重选开头时原样复用，
 * 重烧一两分钟而不是整条 14 分钟。
 *
 * ⚠️ 这一组里最要紧的是【老项目那条】：headBoundaryMs 为 null 的项目
 * 必须完全走老规矩（挑多少算多少，缺口顺延），否则它们的排布一变、
 * 母带指纹跟着变，开机补合会把她已经烧好的片子全部重烧一遍。
 */

let app: FastifyInstance
let dataDir: string
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const LIST = ['定长甲', '定长乙']

// openUserDb 打开的是真实落盘的库，用例之间会互相看到对方建的项目
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
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${bucket}/${filename}`, bucket, filename, durationMs, 1000, '2026-08-14T00:00:00.000Z')
}

/** 开头 20 段各 10 秒；常规、跑酷够铺满剩下的部分就行 */
async function makeApp (): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-openfix-'))
  const lib = openLibraryDb(dataDir)
  for (let i = 0; i < 20; i++) insert(lib, '1-开头', `开头-${String(i).padStart(2, '0')}.mp4`, 10_000)
  for (let i = 0; i < 20; i++) insert(lib, '2-常规', `常规-${String(i).padStart(2, '0')}.mp4`, 10_000)
  for (let i = 0; i < 3; i++) insert(lib, '3-地铁跑酷', `跑酷-${i}.mp4`, 600_000)
  lib.close()
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

/** 建一个配音已就绪的项目。boundary 给 null 就是老项目那一挂 */
async function makeReady (
  a: FastifyInstance, owner: string, cookie: string, name: string,
  opts: { totalMs: number; boundaryMs: number | null },
): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name }, cookies: { sj_session: cookie },
  })
  const id = res.json().id as string
  const db = openUserDb(owner, LIST)
  db.updateProject(id, {
    ttsState: 'ready',
    ttsDurationMs: opts.totalMs,
    ...(opts.boundaryMs === null ? {} : { headBoundaryMs: opts.boundaryMs }),
  })
  db.close()
  return id
}

async function settle (a: FastifyInstance, cookie: string, id: string, pick: string[]) {
  return await a.inject({
    method: 'POST', url: `/api/projects/${id}/opening`, payload: { pick }, cookies: { sj_session: cookie },
  })
}

const ids = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `1-开头/开头-${String(i + from).padStart(2, '0')}.mp4`)

describe('挑不够就不让确认', () => {
  it('总时长短于边界 → 400，并说清还差多少秒', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    // 边界 100 秒，只挑 4 段 × 10 秒 = 40 秒
    const id = await makeReady(a, '定长甲', cookie, '挑不够', { totalMs: 400_000, boundaryMs: 100_000 })

    const res = await settle(a, cookie, id, ids(4))
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toContain('还差 60 秒')
    expect(body.shortBySec).toBe(60)
    expect(body.needMs).toBe(100_000)
  })

  /*
   * ⚠️ 被拒的这一次【什么都不能落】。放行了就等于开头没铺满还开始烧，
   * 而且 opening_state 一旦变成 settled，闸门就没了，用户再也回不到挑选屏。
   */
  it('被拒之后状态原样：不落清单、不放行、不入队', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '拒了别落库', { totalMs: 400_000, boundaryMs: 100_000 })
    const db0 = openUserDb('定长甲', LIST)
    db0.updateProject(id, { openingState: 'pending' })
    db0.close()

    await settle(a, cookie, id, ids(4))

    const db = openUserDb('定长甲', LIST)
    const p = db.getProject(id)!
    db.close()
    expect(p.openingState).toBe('pending')
    expect(parseOpeningPick(p.openingPickJson)).toEqual([])
  })

  it('正好铺满 → 放行', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '正好', { totalMs: 400_000, boundaryMs: 100_000 })

    const res = await settle(a, cookie, id, ids(10))   // 10 × 10s = 100s
    expect(res.statusCode).toBe(200)
    expect(res.json().openingPick).toHaveLength(10)
  })

  /*
   * 超出是【正常且想要的】：跨过边界那一段被截短，正好把开头铺满。
   * 拦超出的活儿在界面上做（不让加），后端不该因为多挑了就报错。
   */
  it('挑多了照样放行——跨界那段会被截短', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '挑多了', { totalMs: 400_000, boundaryMs: 95_000 })

    const res = await settle(a, cookie, id, ids(12))
    expect(res.statusCode).toBe(200)
  })
})

describe('老项目（没有边界）完全走老规矩', () => {
  /*
   * 这是隔离的核心断言。老项目的开头长度 = min(27%, 挑选总长)，
   * 挑不够就把缺口顺延给下一段——**绝不能**因为新规则而被拦下来。
   */
  it('只挑一段也照样放行，不提"还差多少"', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长乙')
    const id = await makeReady(a, '定长乙', cookie, '老项目', { totalMs: 400_000, boundaryMs: null })

    const res = await settle(a, cookie, id, ids(1))
    expect(res.statusCode).toBe(200)
    expect(res.json().openingPick).toEqual(ids(1))

    const db = openUserDb('定长乙', LIST)
    expect(db.getProject(id)!.headBoundaryMs).toBeNull()   // 这条路上永远不该被写上边界
    db.close()
  })
})

describe('「用默认素材」', () => {
  /*
   * 默认清单也必须铺满边界，否则物化出来的那份清单加起来不到边界，
   * 下一次照它排布就直接抛错——用户会卡在一条自己没挑过的片子上。
   */
  it('定长项目的默认清单，加起来 ≥ 边界', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '默认定长', { totalMs: 400_000, boundaryMs: 100_000 })

    const res = await settle(a, cookie, id, [])
    expect(res.statusCode).toBe(200)
    const pick = res.json().openingPick as string[]
    expect(pick.length * 10_000).toBeGreaterThanOrEqual(100_000)   // 每段 10 秒
  })

  it('老项目的默认清单不受影响，仍按 27% 铺', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长乙')
    const id = await makeReady(a, '定长乙', cookie, '默认老的', { totalMs: 400_000, boundaryMs: null })

    const res = await settle(a, cookie, id, [])
    expect(res.statusCode).toBe(200)
    // 27% × 400s = 108s ÷ 每段 10s ≈ 11 段
    expect((res.json().openingPick as string[]).length).toBe(11)
  })
})

describe('「自动」补满', () => {
  /*
   * 「自动」取代了原来的「用默认素材」。老按钮是"我不挑了你看着办"，
   * 现在的规矩是**必须挑够**——自动只是帮他把剩下的补上，补完还能改。
   */
  it('一个都没挑 → 直接铺满整个开头段', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '全自动', { totalMs: 400_000, boundaryMs: 100_000 })

    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/autofill`,
      payload: { pick: [] }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const pick = res.json().pick as string[]
    expect(pick.length * 10_000).toBeGreaterThanOrEqual(100_000)   // 每段 10 秒
    expect(new Set(pick).size).toBe(pick.length)                    // 不重复
  })

  it('挑了几段 → 他挑的原样在前，后面接着补', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '补一半', { totalMs: 400_000, boundaryMs: 100_000 })

    const mine = ids(3)
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/autofill`,
      payload: { pick: mine }, cookies: { sj_session: cookie },
    })
    const body = res.json()
    expect(body.pick.slice(0, 3)).toEqual(mine)                     // 顺序不动
    expect(body.pick.length * 10_000).toBeGreaterThanOrEqual(100_000)
    expect(body.added.every((x: string) => !mine.includes(x))).toBe(true)
  })

  it('已经挑满了 → 什么都不补', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '已经满了', { totalMs: 400_000, boundaryMs: 50_000 })

    const mine = ids(6)   // 60s > 50s
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/autofill`,
      payload: { pick: mine }, cookies: { sj_session: cookie },
    })
    expect(res.json()).toEqual({ pick: mine, added: [] })
  })

  /* 补完就应该能确认——这是这个按钮存在的全部意义 */
  it('自动补完之后，确认能过', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '补完能确认', { totalMs: 400_000, boundaryMs: 100_000 })

    const filled = (await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/autofill`,
      payload: { pick: ids(2) }, cookies: { sj_session: cookie },
    })).json().pick as string[]

    expect((await settle(a, cookie, id, filled)).statusCode).toBe(200)
  })

  it('还没算出分界（配音没好）→ 409，说清等什么', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长乙')
    const id = await makeReady(a, '定长乙', cookie, '老项目', { totalMs: 400_000, boundaryMs: null })

    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/autofill`,
      payload: { pick: [] }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('配音')
  })
})

describe('清单比分界短时，不能把片子卡死', () => {
  /*
   * ⚠️ 线上真踩的死锁：
   *
   * 配音第一次失败（Azure 挂了）→ 那时 head_boundary_ms 还是 null →
   * POST /opening 的"挑够了吗"闸门【形同虚设】（它是按边界判的）→
   * 57 秒的清单就被 settled 了。后来配音成功、边界算出来 81 秒 →
   * 排布要求正好铺满 → planBackground 抛「开头素材不够铺满」→
   * judgeFilm 压成一句"暂时算不出成片需要的素材排布"。
   *
   * 而项目已经是 settled，用户【回不到挑选界面】，自己救不了自己。
   *
   * "必须挑够"是【挑选界面】的规矩，不该由排布来兜底执行——
   * 排布的职责是把片子做出来。
   */
  it('清单不够铺满边界 → 自动补齐，照样算得出排布', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '短清单', { totalMs: 400_000, boundaryMs: 100_000 })

    // 绕过接口直接落一份【不够长】的清单，复现线上那个状态
    const db = openUserDb('定长甲', LIST)
    db.updateProject(id, { openingPickJson: JSON.stringify(ids(4)), openingState: 'settled' })
    db.close()

    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const plan = res.json()
    expect(plan.segments.length).toBeGreaterThan(0)
    // 开头段确实铺满到了边界
    let head = 0
    for (const s of plan.segments) { if (s.bucket !== '1-开头') break; head += s.takeMs }
    expect(head).toBe(100_000)
  })

  it('他自己挑的那几段仍然排在最前面，顺序不动', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const id = await makeReady(a, '定长甲', cookie, '保序', { totalMs: 400_000, boundaryMs: 100_000 })
    const mine = ids(3)
    const db = openUserDb('定长甲', LIST)
    db.updateProject(id, { openingPickJson: JSON.stringify(mine), openingState: 'settled' })
    db.close()

    const plan = (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json()
    expect(plan.segments.slice(0, 3).map((s: { itemId: string }) => s.itemId)).toEqual(mine)
  })
})

describe('配音没就绪，不许敲定开头', () => {
  /*
   * ⚠️ 这就是那个死锁的【源头】。
   *
   * 开头要铺多长是从配音总长算出来的，所以"挑够了吗"那道闸判的是
   * head_boundary_ms——而配音没好时它是 null，于是【整道闸不参与】，
   * 只剩"至少挑了一段"。线上她在 Azure 挂掉时挑了 57 秒就确认了，
   * 后来配音成功、边界算出来 81 秒，这条片子从此合不出来，
   * 而 settled 之后她回不到挑选界面，自己救不了自己。
   */
  it('配音还在生成 → 409，不落清单、不放行', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const res0 = await a.inject({
      method: 'POST', url: '/api/projects', payload: { name: '配音还没好' }, cookies: { sj_session: cookie },
    })
    const id = res0.json().id as string
    const db0 = openUserDb('定长甲', LIST)
    db0.updateProject(id, { ttsState: 'generating', openingState: 'pending' })
    db0.close()

    const res = await settle(a, cookie, id, ids(2))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('还在生成')

    const db = openUserDb('定长甲', LIST)
    const p = db.getProject(id)!
    db.close()
    expect(p.openingState).toBe('pending')                      // 闸门还在
    expect(parseOpeningPick(p.openingPickJson)).toEqual([])      // 什么都没落
  })

  it('配音失败 → 409，并且说清要回去重新生成', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const res0 = await a.inject({
      method: 'POST', url: '/api/projects', payload: { name: '配音失败了' }, cookies: { sj_session: cookie },
    })
    const id = res0.json().id as string
    const db0 = openUserDb('定长甲', LIST)
    db0.updateProject(id, { ttsState: 'error', openingState: 'pending' })
    db0.close()

    const res = await settle(a, cookie, id, ids(2))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('重新生成')
  })

  /* 草稿不受影响——挑一半接个电话是常态，那一份随时都该存得下 */
  it('配音没好也照样能存草稿', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '定长甲')
    const res0 = await a.inject({
      method: 'POST', url: '/api/projects', payload: { name: '存草稿' }, cookies: { sj_session: cookie },
    })
    const id = res0.json().id as string
    const db0 = openUserDb('定长甲', LIST)
    db0.updateProject(id, { ttsState: 'generating', openingState: 'pending' })
    db0.close()

    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/opening/draft`,
      payload: { pick: ids(2) }, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const db = openUserDb('定长甲', LIST)
    expect(parseOpeningPick(db.getProject(id)!.openingPickJson)).toEqual(ids(2))
    db.close()
  })
})
