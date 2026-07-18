import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

describe('whoami 带欢迎语', () => {
  it('未登录时 name 和 welcome 都是 null', async () => {
    app = buildServer({ authDbPath: ':memory:', whitelist: ['甲'], cookieSecret: 'test-secret-32-chars-long-abcdef' })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(res.json()).toEqual({ name: null, welcome: null })
  })

  it('登录后返回姓名和对应欢迎语', async () => {
    app = buildServer({
      authDbPath: ':memory:', whitelist: ['甲'],
      cookieSecret: 'test-secret-32-chars-long-abcdef',
      welcome: { '甲': '欢迎甲同学' },
    })
    await app.ready()
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '甲', password: 'pass1234' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(res.json()).toEqual({ name: '甲', welcome: '欢迎甲同学' })
  })

  it('名单内但没配欢迎语时给通用文案，不是 null', async () => {
    app = buildServer({
      authDbPath: ':memory:', whitelist: ['乙'],
      cookieSecret: 'test-secret-32-chars-long-abcdef',
      welcome: {},
    })
    await app.ready()
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '乙', password: 'pass1234' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(res.json().welcome).toBe('欢迎回来')
  })
})
