import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

// buildServer 支持注入内存 authDb 和白名单用于测试
async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: ['张三', '李四'] })
  await a.ready()
  return a
}

describe('登录流程', () => {
  it('名单外姓名被拒', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '王五', password: 'x' } })
    expect(res.statusCode).toBe(403)
  })

  it('名单内首次登录——设置密码并登入', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'first-pw' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '张三', firstLogin: true })
    expect(res.cookies.find((c) => c.name === 'sj_session')).toBeTruthy()
  })

  it('第二次用正确密码登入', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '张三', firstLogin: false })
  })

  it('第二次用错误密码被拒 401', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pw' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'wrong' } })
    expect(res.statusCode).toBe(401)
  })

  it('whoami 未登录返回 null，登录后返回姓名', async () => {
    app = await makeApp()
    const anon = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(anon.json()).toEqual({ name: null })
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '李四', password: 'pw' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const who = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(who.json()).toEqual({ name: '李四' })
  })
})
