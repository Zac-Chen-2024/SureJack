import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildServer } from '../../src/server.js'
import { synthesizeLong } from '../../src/tts/index.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
afterEach(async () => { await app?.close(); vi.unstubAllEnvs() })

/**
 * 让路由过掉「缺 Azure 配置」那道检查。假的 key/region 是安全的：
 * 合成本身被 fakeSynth 顶掉了，不会有任何网络请求。
 */
function withAzureEnv () {
  vi.stubEnv('AZURE_SPEECH_KEY', 'fake-key')
  vi.stubEnv('AZURE_SPEECH_REGION', 'fake-region')
}

const LIST = ['测试配音甲']

/**
 * 假合成：按 splitScript 的规则算出段数，但【不落盘、不拼接、不打 Azure】。
 * 路由测试只关心「长文案不再被拒绝」和「segmentCount 透传到响应」，
 * 分段与时间轴的正确性由 tests/tts/long.test.ts 覆盖。
 */
function fakeSynth (segmentCount: number): typeof synthesizeLong {
  return async (opts) => ({
    audioPath: opts.outPath,
    words: [{ text: '他', offsetMs: 0, durationMs: 200, isPunctuation: false }],
    durationMs: 200,
    segmentCount,
  })
}

async function makeApp (synth?: typeof synthesizeLong) {
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg',
    synthesizeLong: synth,
  })
  await a.ready()
  return a
}

/** 建项目并写入文案，返回项目 id */
async function makeProject (a: FastifyInstance, cookie: string, scriptText: string): Promise<string> {
  const p = (await a.inject({
    method: 'POST', url: '/api/projects', payload: { name: '项目' },
    cookies: { sj_session: cookie },
  })).json()
  await a.inject({
    method: 'PATCH', url: `/api/projects/${p.id}`,
    payload: { scriptText }, cookies: { sj_session: cookie },
  })
  return p.id as string
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

  /*
   * 原先这里有一条「文案超长时拒绝」。长度拦截已经移除——超长文案改由
   * synthesizeLong 自动切段消化，用户不必手工拆项目。下面两条正是它的反面。
   */
  it('超长文案不再被拒绝，正常合成', async () => {
    withAzureEnv()
    app = await makeApp(fakeSynth(2))
    const cookie = await loginAs(app, '测试配音甲')
    // 4000 字 × 196ms ≈ 13 分钟，按旧规则会被 400 拦下
    const id = await makeProject(app, cookie, '他决定去买包子。'.repeat(500))
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ttsState).toBe('ready')
  })

  it('响应带上 segmentCount，前端据此提示已分段', async () => {
    withAzureEnv()
    app = await makeApp(fakeSynth(3))
    const cookie = await loginAs(app, '测试配音甲')
    const id = await makeProject(app, cookie, '他决定去买包子。'.repeat(500))
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie },
    })
    expect(res.json().segmentCount).toBe(3)
  })

  it('短文案 segmentCount 为 1（直通路径，行为与改动前一致）', async () => {
    withAzureEnv()
    app = await makeApp(fakeSynth(1))
    const cookie = await loginAs(app, '测试配音甲')
    const id = await makeProject(app, cookie, '他决定去买包子。')
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().segmentCount).toBe(1)
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
