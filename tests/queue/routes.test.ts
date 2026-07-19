import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let dataDir = ''
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = ''
})

const LIST = ['测试导出甲']

// ⚠️ 素材库指向【临时目录】：导出走公式模式时会查素材库，
// 绝不能碰真实的 data/library/（8.5GB，地铁跑酷单文件 1GB）。
async function makeApp () {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-export-'))
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg', libraryDataDir: dataDir,
  })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

describe('导出接口 —— 提交前校验（早失败）', () => {
  it('未登录返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/projects/x/export' })
    expect(res.statusCode).toBe(401)
  })

  /*
   * 原来这条断言的是「没有背景视频 → 提示先传素材」。
   * 公式模式落地后【没上传背景视频不再是错误】——背景由素材库现拼。
   * 这条路径上真正缺的第一样东西是配音（背景长度由它决定），
   * 所以断言随之改成配音。公式模式自己的校验见 export-formula.test.ts。
   */
  it('既没上传背景视频也没配音时，先要配音', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '无素材' }, cookies: { sj_session: cookie } })).json()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/export`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('配音')
  })

  it('没有配音时拒绝，提示先生成配音', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '无配音' }, cookies: { sj_session: cookie } })).json()
    // 只加背景视频，不加配音
    const db = (await import('../../src/db/user-db.js')).openUserDb('测试导出甲', LIST)
    db.addAsset({ projectId: p.id, kind: 'video', path: '/tmp/fake.mp4', originalName: 'a.mp4', size: 1, durationMs: 6000 })
    db.close()
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/export`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('配音')
  })

  it('项目不存在返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const res = await app.inject({ method: 'POST', url: '/api/projects/无此项目/export', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })
})

describe('SSE 进度流', () => {
  it('未登录订阅返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/jobs/anyjob/stream' })
    expect(res.statusCode).toBe(401)
  })

  it('不存在的作业返回 404', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试导出甲')
    const res = await app.inject({ method: 'GET', url: '/api/jobs/无此作业/stream', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })
})
