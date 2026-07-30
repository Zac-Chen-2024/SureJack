import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import type { RenameAnalysis } from '../../src/rename/types.js'
import type { analyzeNovel, reviewCleanup } from '../../src/rename/deepseek.js'

let app: FastifyInstance
afterEach(async () => { await app?.close(); vi.unstubAllEnvs() })

const LIST = ['测试改名路由甲']

const FAKE: RenameAnalysis = {
  chapterHeadings: ['第一章 归来'],
  characters: [{
    original: '沈砚之', replacement: '沈屿之', role: 'protagonist',
    pairs: [
      { from: '沈砚之', to: '沈屿之', global: true },
      { from: '砚之', to: '屿之', global: true },
    ],
  }],
  relationships: [],
}
const fakeAnalyze: typeof analyzeNovel = async () => FAKE
/** 假复查（API-2）：把"孤立的数字行"当漏网内容捞出来 */
const fakeReview: typeof reviewCleanup = async (text) => ({
  removeLines: text.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)),
  leftoverNames: [],
})

const fakeSynth = (): NonNullable<Parameters<typeof buildServer>[0]>['synthesizeLong'] =>
  async (opts) => ({
    audioPath: opts.outPath,
    words: [{ text: '他', offsetMs: 0, durationMs: 200, isPunctuation: false }],
    durationMs: 200, segmentCount: 1,
  })

async function makeApp () {
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg',
    analyzeNovel: fakeAnalyze,
    reviewNovel: fakeReview,
    synthesizeLong: fakeSynth(),
  })
  await a.ready()
  return a
}
async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}
async function newProject (a: FastifyInstance, cookie: string, scriptText: string): Promise<string> {
  const p = (await a.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
  await a.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { scriptText }, cookies: { sj_session: cookie } })
  return p.id as string
}
async function getProject (a: FastifyInstance, cookie: string, id: string) {
  const list = (await a.inject({ method: 'GET', url: '/api/projects', cookies: { sj_session: cookie } })).json()
  return list.find((p: { id: string }) => p.id === id)
}

describe('改名接口', () => {
  it('analyze：调分析、落库 proposed + 映射，返回 analysis', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '第一章 归来\n沈砚之回来了。')
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().analysis.characters[0].replacement).toBe('沈屿之')
    const p = await getProject(app, cookie, id)
    expect(p.renameState).toBe('proposed')
    expect(JSON.parse(p.renameMapJson).characters[0].original).toBe('沈砚之')
  })

  it('confirm：套用到原文（去章节+改名），覆写 scriptText，置 confirmed', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '第一章 归来\n沈砚之回来了。砚之笑了。')
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/confirm`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)
    const p = await getProject(app, cookie, id)
    expect(p.renameState).toBe('confirmed')
    expect(p.scriptText).toBe('沈屿之回来了。屿之笑了。')   // 章节行删除 + 改名
  })

  it('confirm 可带编辑后的映射', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '沈砚之回来了。')
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    const edited: RenameAnalysis = {
      chapterHeadings: [], relationships: [],
      characters: [{ original: '沈砚之', replacement: '沈钰之', role: 'protagonist', pairs: [{ from: '沈砚之', to: '沈钰之', global: true }] }],
    }
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/confirm`, payload: { analysis: edited }, cookies: { sj_session: cookie } })
    const p = await getProject(app, cookie, id)
    expect(p.scriptText).toBe('沈钰之回来了。')   // 用了用户编辑的"钰"
  })

  it('状态阻拦：未确认改名 → 配音 409；确认后放行', async () => {
    app = await makeApp()
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake'); vi.stubEnv('AZURE_SPEECH_REGION', 'fake')
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '沈砚之回来了。')   // 新文本项目默认开改名
    const blocked = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie } })
    expect(blocked.statusCode).toBe(409)

    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/confirm`, cookies: { sj_session: cookie } })
    const ok = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie } })
    expect(ok.statusCode).toBe(200)
  })

  /*
   * API-2 的价值：孤立的数字行（纯章节号）只有语义判得出来，第一层的
   * chapterHeadings 常常漏掉——第二层复查负责把它捞掉。
   */
  it('confirm 会跑第二层复查，捞掉第一层漏掉的孤立数字行（章节号）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '第一章 归来\n17\n沈砚之回来了。')
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/confirm`, cookies: { sj_session: cookie } })
    const p = await getProject(app, cookie, id)
    expect(p.scriptText).toBe('沈屿之回来了。')          // 章节行 + 数字行都没了
    expect(JSON.parse(p.renameAnalysisJson).review.removeLines).toEqual(['17'])
  })

  it('复查失败不阻塞确认，错误记下来供前端重试', async () => {
    app = buildServer({
      authDbPath: ':memory:', whitelist: LIST,
      cookieSecret: 'test-secret-32-chars-long-abcdefg',
      analyzeNovel: fakeAnalyze,
      reviewNovel: async () => { throw new Error('DeepSeek 超时') },
      synthesizeLong: fakeSynth(),
    })
    await app.ready()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '沈砚之回来了。')
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/analyze`, cookies: { sj_session: cookie } })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/confirm`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)                     // 照常确认
    const p = await getProject(app, cookie, id)
    expect(p.renameState).toBe('confirmed')
    expect(p.scriptText).toBe('沈屿之回来了。')            // 第一层结果保留
    expect(JSON.parse(p.renameAnalysisJson).reviewError).toContain('超时')
  })

  it('重试接口 /rename/review 能单独再跑一次复查', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '沈屿之回来了。\n23')
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/review`, cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().review.removeLines).toEqual(['23'])
    expect((await getProject(app, cookie, id)).scriptText).toBe('沈屿之回来了。')
  })

  it('toggle 关掉改名 → 配音不再被拦', async () => {
    app = await makeApp()
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake'); vi.stubEnv('AZURE_SPEECH_REGION', 'fake')
    const cookie = await loginAs(app, '测试改名路由甲')
    const id = await newProject(app, cookie, '沈砚之回来了。')
    await app.inject({ method: 'POST', url: `/api/projects/${id}/rename/toggle`, payload: { enabled: false }, cookies: { sj_session: cookie } })
    const ok = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie } })
    expect(ok.statusCode).toBe(200)
  })
})
