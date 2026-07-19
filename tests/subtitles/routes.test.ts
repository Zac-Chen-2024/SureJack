import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { buildAssForProject, deriveSubtitleLines } from '../../src/subtitles/project-ass.js'
import type { WordTiming } from '../../src/types.js'

// 超时放宽到 30s：每个用例都要建服务器 + scrypt 登录 + 落地 SQLite，
// 本机磁盘繁忙时单个用例偶尔会超过 vitest 默认的 5s（与被测逻辑无关）。
let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试字幕甲', '测试字幕乙']

async function makeApp (): Promise<FastifyInstance> {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  const cookie = res.cookies.find((c) => c.name === 'sj_session')
  if (!cookie) throw new Error(`登录失败：${res.statusCode} ${res.body}`)
  return cookie.value
}

async function newProject (a: FastifyInstance, cookie: string, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/projects', payload: { name }, cookies: { sj_session: cookie } })
  return res.json().id as string
}

/** 三个词 + 一个标点的词时间轴，模拟 Azure WordBoundary 的产出 */
const WORDS: WordTiming[] = [
  { text: '他', offsetMs: 0, durationMs: 300, isPunctuation: false },
  { text: '决定', offsetMs: 300, durationMs: 500, isPunctuation: false },
  { text: '去买包子', offsetMs: 800, durationMs: 900, isPunctuation: false },
  { text: '。', offsetMs: 1700, durationMs: 100, isPunctuation: true },
]

function seedTimings (user: string, projectId: string): void {
  const db = openUserDb(user, LIST)
  try {
    db.updateProject(projectId, {
      ttsState: 'ready',
      ttsDurationMs: 1800,
      wordTimingsJson: JSON.stringify(WORDS),
    })
  } finally { db.close() }
}

function getProject (user: string, projectId: string) {
  const db = openUserDb(user, LIST)
  try { return db.getProject(projectId) } finally { db.close() }
}

describe('字幕派生接口 —— 鉴权', { timeout: 30_000 }, () => {
  it('未登录返回 401', async () => {
    app = await makeApp()
    const r = await app.inject({ method: 'GET', url: '/api/projects/x/subtitles' })
    expect(r.statusCode).toBe(401)
  })

  it('未登录取 ASS 也返回 401', async () => {
    app = await makeApp()
    const r = await app.inject({ method: 'GET', url: '/api/projects/x/subtitles.ass' })
    expect(r.statusCode).toBe(401)
  })

  it('项目不存在返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const r = await app.inject({ method: 'GET', url: '/api/projects/无此项目/subtitles', cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(404)
  })

  it('别人的项目拿不到字幕', async () => {
    app = await makeApp()
    const jia = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, jia, '甲的私密项目')
    seedTimings('测试字幕甲', id)

    // 甲自己能拿到
    const mine = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: jia } })
    expect(mine.statusCode).toBe(200)

    const yi = await loginAs(app, '测试字幕乙')
    const theirs = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: yi } })
    expect(theirs.statusCode).toBe(404)

    const theirsAss = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: yi } })
    expect(theirsAss.statusCode).toBe(404)
  })
})

describe('字幕派生接口 —— 派生行', { timeout: 30_000 }, () => {
  it('没生成配音时返回空列表而不是 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '还没配音')
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ lines: [] })
  })

  it('没生成配音时 ASS 是 200 且没有字幕对白行', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '还没配音的ASS')
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('[Script Info]')
    expect(r.body).not.toContain(',Sub,,')
  })

  it('有词时间轴时推导出字幕行', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '有配音')
    seedTimings('测试字幕甲', id)

    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(200)
    const lines = r.json().lines as Array<{ startMs: number; endMs: number; words: WordTiming[] }>
    expect(lines.length).toBeGreaterThan(0)
    // 整体比对，避免 arr[0].field（noUncheckedIndexedAccess）
    expect(lines.map((l) => [l.startMs, l.endMs])).toEqual([[0, 1800]])
    expect(lines.map((l) => l.words.map((w) => w.text).join(''))).toEqual(['他决定去买包子。'])
  })

  it('接口返回的行与共用派生函数一致', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '派生一致')
    seedTimings('测试字幕甲', id)

    const project = getProject('测试字幕甲', id)
    expect(project).not.toBeNull()
    if (!project) return
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: cookie } })
    expect(r.json()).toEqual({ lines: JSON.parse(JSON.stringify(deriveSubtitleLines(project))) })
  })

  it('字幕是派生数据，不写回数据库', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '不落库')
    seedTimings('测试字幕甲', id)
    const before = getProject('测试字幕甲', id)
    await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: cookie } })
    await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })
    const after = getProject('测试字幕甲', id)
    expect(after).toEqual(before)
  })
})

describe('字幕派生接口 —— ASS', { timeout: 30_000 }, () => {
  it('ASS 接口返回可解析的字幕文本', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, 'ASS可解析')
    seedTimings('测试字幕甲', id)

    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/plain')
    expect(r.body).toContain('[Script Info]')
    expect(r.body).toContain('[Events]')
    expect(r.body).toContain('[V4+ Styles]')
    // 标题与免责声明必须在场——预览要和成片长一个样
    expect(r.body).toContain('ASS可解析')
    expect(r.body).toContain('小说内容纯属虚构，无不良引导')
  })

  /*
   * 【这条是 WYSIWYG 的地基】预览用的 ASS 必须和导出烧录的完全一致。
   * 两处若各自构造，样式迟早会漂移，而症状是「预览好好的，导出不对」——
   * 极难排查。所以构造逻辑必须是同一个函数。
   */
  it('预览的 ASS 与导出用的 ASS 逐字节相同', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '逐字节相同')
    seedTimings('测试字幕甲', id)

    const project = getProject('测试字幕甲', id)
    expect(project).not.toBeNull()
    if (!project) return
    const preview = (await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })).body
    const exported = buildAssForProject(project)   // 导出路径调的同一个函数
    expect(preview).toBe(exported)
  })

  /*
   * 上一条只能证明【预览】走了共用函数；导出路径要真跑一次 ffmpeg 才能
   * 端到端验，太重。改用源码级约束钉住另一半：导出路由必须调
   * buildAssForProject，且不得自己再拼一遍 ASS。
   */
  it('导出路由用的是同一个共用函数，没有自己拼 ASS', () => {
    const src = readFileSync(new URL('../../src/queue/routes.ts', import.meta.url), 'utf-8')
    expect(src).toContain('buildAssForProject')
    expect(src).not.toContain('buildAss(')
    expect(src).not.toContain('segmentLines(')
  })

  it('ASS 随画幅设置变化（预览与导出共享同一份画幅推导）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '换画幅')
    seedTimings('测试字幕甲', id)

    const vertical = (await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })).body
    expect(vertical).toContain('PlayResY: 1920')

    await app.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { aspectRatio: '16:9' }, cookies: { sj_session: cookie },
    })
    const wide = (await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })).body
    expect(wide).toContain('PlayResX: 1920')
    expect(wide).toContain('PlayResY: 1080')
  })

  it('未知画幅回落到 9:16 而不是崩', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试字幕甲')
    const id = await newProject(app, cookie, '怪画幅')
    seedTimings('测试字幕甲', id)
    const db = openUserDb('测试字幕甲', LIST)
    try { db.updateProject(id, { aspectRatio: '3:7' }) } finally { db.close() }

    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('PlayResX: 1080')
    expect(r.body).toContain('PlayResY: 1920')
  })
})
