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
