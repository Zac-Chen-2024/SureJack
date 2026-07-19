import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { DEFAULT_SUBTITLE_MARGIN_V } from '../../src/subtitles/ass.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let dataDir = ''
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const LIST = ['测试字幕高度乙']

beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

/** 素材库指向临时目录——绝不碰真实的 data/library/ */
async function makeApp (): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-margin-'))
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
    method: 'POST', url: '/api/projects', payload: { name: '高度项目' },
    cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

async function patch (
  a: FastifyInstance, cookie: string, id: string, payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await a.inject({
    method: 'PATCH', url: `/api/projects/${id}`, payload, cookies: { sj_session: cookie },
  })
  return { statusCode: res.statusCode, body: res.json() }
}

describe('PATCH /api/projects/:id —— subtitleMarginV', () => {
  it('能改，默认值是加这个参数之前样式行里写死的那个数', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)

    const before = await a.inject({ method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie } })
    expect(before.json().subtitleMarginV).toBe(DEFAULT_SUBTITLE_MARGIN_V)

    const res = await patch(a, cookie, id, { subtitleMarginV: 640 })
    expect(res.statusCode).toBe(200)
    expect(res.body.subtitleMarginV).toBe(640)

    const got = await a.inject({ method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie } })
    expect(got.json().subtitleMarginV).toBe(640)
  })

  /**
   * MarginV 直接进样式行，libass 照单全收：负数或者大过画面高度，
   * 字幕就跑到画外了——用户看到的是"字幕没了"，而不是"我拖过头了"。
   * 所以钳位必须在【路由层】，前端的滑块范围只是体验，不是防线。
   */
  /*
   * 下限是 160 而不是 0：免责声明固定在 MarginV=90、字号 32，占据 90～122。
   * 字幕底边就是它的 MarginV，低于 122 会压在免责声明上。160 是在 122 之上
   * 再留约 38px 呼吸。
   */
  it('负数被钳到下限 160，不是 0', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    expect((await patch(a, cookie, id, { subtitleMarginV: -200 })).body.subtitleMarginV).toBe(160)
  })

  it('超过画面高度一半的值被钳到一半（9:16 → 960）', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    expect((await patch(a, cookie, id, { subtitleMarginV: 5000 })).body.subtitleMarginV).toBe(960)
  })

  it('钳位上界跟着项目画幅走，不是写死 960', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    await patch(a, cookie, id, { aspectRatio: '16:9' })   // 1920×1080
    expect((await patch(a, cookie, id, { subtitleMarginV: 5000 })).body.subtitleMarginV).toBe(540)
  })

  it('同一次请求里一起改画幅时，按【新】画幅钳位', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    const res = await patch(a, cookie, id, { aspectRatio: '16:9', subtitleMarginV: 900 })
    expect(res.body.subtitleMarginV).toBe(540)
  })

  /**
   * 换成更矮的画幅时，存着的旧值可能已经超过新画面的一半——不重新钳位的话
   * 用户只是换了个画幅，字幕就凭空跑到画外去了。
   */
  it('单独改画幅也会把存着的值重新钳进新画幅的范围', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    await patch(a, cookie, id, { subtitleMarginV: 900 })
    const res = await patch(a, cookie, id, { aspectRatio: '16:9' })
    expect(res.body.subtitleMarginV).toBe(540)
  })

  it('低于下限的值被抬到 160——绝不让字幕压在免责声明上', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    expect((await patch(a, cookie, id, { subtitleMarginV: 0 })).body.subtitleMarginV).toBe(160)
  })

  it('小数被取整——MarginV 是像素，样式行里不该出现 300.5', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    expect((await patch(a, cookie, id, { subtitleMarginV: 412.7 })).body.subtitleMarginV).toBe(413)
  })

  it('非数字 / NaN / Infinity 一律忽略，保持原值', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    await patch(a, cookie, id, { subtitleMarginV: 500 })

    for (const bad of ['400', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await patch(a, cookie, id, { subtitleMarginV: bad })
      expect(res.body.subtitleMarginV).toBe(500)
    }
  })

  it('改完之后 subtitles.ass 立刻跟着变——预览和成片读的是同一份', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试字幕高度乙')
    const id = await newProject(a, cookie)
    await patch(a, cookie, id, { subtitleMarginV: 640 })

    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const sub = res.body.split('\n').find((l) => l.startsWith('Style: Sub,'))
    expect(sub?.endsWith(',60,60,640,1')).toBe(true)
    // 免责声明留在原地
    const dis = res.body.split('\n').find((l) => l.startsWith('Style: Disclaimer,'))
    expect(dis?.endsWith(',60,60,90,1')).toBe(true)
  })
})
