import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试甲', '测试乙']

// ⚠️ 这段不在 brief 给的测试代码里，是补的：openUserDb 打开的是【真实落盘】的库
// （物理隔离设计的一部分——Task1 就是这么定的），`authDbPath: ':memory:'` 只管
// auth db，管不到每个用户自己的 project 库。用例里 '测试甲'/'测试乙' 是复用的
// 真实姓名，不清理的话上一条用例建的项目会在下一条用例的库里赖着不走——哪怕
// 用全新的 data/ 目录跑，"删项目"这条内部也会因为前两条用例（"能建项目并列出来"
// "改文案"）留下的项目而不是 0 条而失败。跟 tests/db/user-db-crud.test.ts 的
// fresh() 是同一个套路：每条用例前把这两个人的 projects 表清空，只清状态，
// 不碰下面任何一条用例本身的代码。
beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

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
