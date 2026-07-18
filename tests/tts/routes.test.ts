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
