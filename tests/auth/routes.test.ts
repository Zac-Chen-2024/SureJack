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

  it('首次登录密码太短被拒 400', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'ab' } })
    expect(res.statusCode).toBe(400)
  })

  it('第二次用正确密码登入', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pass' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pass' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: '张三', firstLogin: false })
  })

  it('第二次用错误密码被拒 401', async () => {
    app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'pass' } })
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'wrong' } })
    expect(res.statusCode).toBe(401)
  })

  it('whoami 未登录返回 null，登录后返回姓名', async () => {
    app = await makeApp()
    const anon = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(anon.json()).toEqual({ name: null })
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '李四', password: 'pass' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const who = await app.inject({ method: 'GET', url: '/api/whoami', cookies: { sj_session: cookie } })
    expect(who.json()).toEqual({ name: '李四' })
  })
})

describe('入参类型校验（Part A 分支评审必修1）', () => {
  // 未登录、零前置条件即可触发：name/password 是 JSON，可以传数字/数组/对象。
  // 老代码 req.body?.name?.trim() 对非字符串直接抛 TypeError，被 Fastify 兜底成
  // 500 并把 "xxx.trim is not a function" 原样吐给客户端，泄漏内部实现细节。
  it('name 是数字——干净 400，不是 500，响应体不含内部错误原文', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: 12345, password: 'abcdefgh' } })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(JSON.stringify(body)).not.toMatch(/trim is not a function/)
    expect(JSON.stringify(body)).not.toMatch(/is not a function/)
  })

  it('name 是数组——400 不是 500', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: ['a', 'b'], password: 'abcdefgh' } })
    expect(res.statusCode).toBe(400)
  })

  it('password 是数字——400 不是 500', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 12345678 } })
    expect(res.statusCode).toBe(400)
  })

  it('password 是对象——400 不是 500', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: { a: 1 } } })
    expect(res.statusCode).toBe(400)
  })
})

describe('限流分离（Part A 分支评审必修2）：whoami 不占用 login 的额度', () => {
  it('大量 whoami 调用不影响随后的 login（不会被顶到 429）', async () => {
    app = await makeApp()
    // 老代码里 whoami 和 login 共享同一个"每分钟10次"的桶；
    // 20 次 whoami 足以在老实现下把桶打满，让下面的 login 直接 429。
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/whoami' })
      expect(r.statusCode).toBe(200)
    }
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'first-pw' } })
    expect(res.statusCode).toBe(200)
  })

  it('login 本身依然被限流：连续超额会 429（确认没有把限流整个关掉）', async () => {
    app = await makeApp()
    let last
    for (let i = 0; i < 11; i++) {
      last = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'same-password-1' } })
    }
    expect(last!.statusCode).toBe(429)
  })
})
