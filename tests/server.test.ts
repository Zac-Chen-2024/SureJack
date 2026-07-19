import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, loadWhitelistFrom, attachErrorHandler } from '../src/server.js'
import { registerAuthRoutes } from '../src/auth/routes.js'
import type { AuthDb } from '../src/db/auth-db.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

describe('buildServer', () => {
  it('健康检查端点返回 200', async () => {
    app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('attachErrorHandler（Part A 分支评审必修1）：非预期异常不泄漏内部细节', () => {
  it('DB 抛出的异常只回通用 500 消息，不把 error.message/文件路径吐给客户端', async () => {
    // 复现评审报告里的场景：setPassword 抛一个"非抢注竞态"的错误（比如真实的
    // SQLITE_IOERR，会带着数据库文件路径），routes.ts 选择不吞、重新 throw，
    // 交给全局错误处理器兜底——必须验证兜底之后客户端看到的是通用消息。
    const sensitiveMessage = 'SQLITE_IOERR: disk I/O error at /root/SureJack/data/auth.db'
    const fakeAuthDb: AuthDb = {
      hasPassword: () => false,
      async setPassword () { throw new Error(sensitiveMessage) },
      async checkPassword () { return false },
      getFirstLoginInfo: () => null,
      close () {},
    }
    app = Fastify({ logger: false })
    attachErrorHandler(app)
    registerAuthRoutes(app, { authDb: fakeAuthDb, whitelist: ['张三'], welcome: {} })
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '张三', password: 'abcdefgh' } })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('服务器内部错误')
    const raw = res.body
    expect(raw).not.toMatch(/SQLITE_IOERR/)
    expect(raw).not.toMatch(/auth\.db/)
    expect(raw).not.toMatch(/data\//)
  })

  /*
   * 5xx 要带一个能和服务端日志对上的 reqId。
   *
   * 只回「服务器内部错误」是不够的：调背景排布那个 500 时，为了看真实
   * 堆栈把服务重启加日志跑了两遍才定位到「配音时长是小数」——客户端
   * 手里没有任何能跟日志对上的东西。reqId 让用户报错时能直接定位那一条。
   */
  it('5xx 带 reqId，且仍然不泄露内部信息', async () => {
    app = Fastify({ logger: false })
    attachErrorHandler(app)
    app.get('/api/__boom', async () => {
      throw new Error('SQLITE_IOERR at /root/SureJack/data/auth.db')
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/__boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('服务器内部错误')
    // 有 reqId 才能跟日志对上
    expect(typeof res.json().reqId).toBe('string')
    expect(res.json().reqId.length).toBeGreaterThan(0)
    // 加了 reqId 也不能顺手把内部信息带出去
    expect(res.body).not.toMatch(/SQLITE_IOERR/)
    expect(res.body).not.toMatch(/auth\.db/)
  })

  /* 4xx 是给用户看的可操作信息，不该被 reqId 污染 */
  it('4xx 不带 reqId，原样返回可操作的错误信息', async () => {
    app = Fastify({ logger: false })
    attachErrorHandler(app)
    app.get('/api/__bad', async (_req, reply) => reply.code(400).send({ error: '先生成配音' }))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/__bad' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: '先生成配音' })
  })
})

describe('loadWhitelistFrom（Part A 分支评审必修3）：文件存在但格式损坏必须抛错，不能静默降级', () => {
  function makeRoot (): string {
    const root = mkdtempSync(join(tmpdir(), 'sj-whitelist-'))
    mkdirSync(join(root, 'config'))
    return root
  }

  it('真名单不存在——回退到 example（合理降级）', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'config', 'whitelist.example.json'), JSON.stringify(['示例甲', '示例乙']))
    expect(loadWhitelistFrom(root)).toEqual(['示例甲', '示例乙'])
  })

  it('真名单存在且合法——优先于 example', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'config', 'whitelist.json'), JSON.stringify(['真张三', '真李四']))
    writeFileSync(join(root, 'config', 'whitelist.example.json'), JSON.stringify(['示例甲']))
    expect(loadWhitelistFrom(root)).toEqual(['真张三', '真李四'])
  })

  it('真名单存在但内容不是字符串数组——抛错，绝不静默降级到 example', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'config', 'whitelist.json'), JSON.stringify({ not: 'array' }))
    writeFileSync(join(root, 'config', 'whitelist.example.json'), JSON.stringify(['示例甲']))
    expect(() => loadWhitelistFrom(root)).toThrow()
  })

  it('真名单存在但 JSON 语法损坏——抛错，绝不静默降级到 example', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'config', 'whitelist.json'), '{this is not valid json')
    writeFileSync(join(root, 'config', 'whitelist.example.json'), JSON.stringify(['示例甲']))
    expect(() => loadWhitelistFrom(root)).toThrow()
  })

  it('真名单数组里混了非字符串元素——抛错', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'config', 'whitelist.json'), JSON.stringify(['张三', 123]))
    expect(() => loadWhitelistFrom(root)).toThrow()
  })

  it('真名单和 example 都不存在——抛"找不到"错误', () => {
    const root = makeRoot()
    expect(() => loadWhitelistFrom(root)).toThrow(/找不到/)
  })
})
