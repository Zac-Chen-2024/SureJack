import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../src/server.js'
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
