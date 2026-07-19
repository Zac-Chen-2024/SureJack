import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'

const run = promisify(execFile)

let app: FastifyInstance
let dataDir: string
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const LIST = ['自备派生甲', '自备派生乙']

beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

/** 3 秒静音 mp3。现场生成，不引用 .gitignore 里的开发者本机文件 */
async function makeTestMp3 (seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'adopt-mp3-'))
  try {
    const path = join(dir, 'a.mp3')
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${seconds}`,
      '-t', String(seconds), path])
    return readFileSync(path)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const SRT = `1
00:00:00,000 --> 00:00:01,200
第一句话

2
00:00:01,500 --> 00:00:02,800
第二句话
`

function insert (db: LibraryDb, bucket: string, filename: string, durationMs: number): void {
  db.raw.prepare(
    `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${bucket}/${filename}`, bucket, filename, durationMs, 1000, '2026-07-19T00:00:00.000Z')
}

async function makeApp (): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-adopt-'))
  const lib = openLibraryDb(dataDir)
  for (let i = 0; i < 20; i++) insert(lib, '1-开头', `开头-${String(i).padStart(2, '0')}.mp4`, 1000)
  for (let i = 0; i < 20; i++) insert(lib, '2-常规', `常规-${String(i).padStart(2, '0')}.mp4`, 1000)
  for (let i = 0; i < 3; i++) insert(lib, '3-地铁跑酷', `跑酷-${i}.mp4`, 600_000)
  lib.close()
  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg', libraryDataDir: dataDir,
  })
  await a.ready()
  app = a
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  const c = res.cookies.find((x) => x.name === 'sj_session')
  if (!c) throw new Error(`登录失败：${res.statusCode} ${res.body}`)
  return c.value
}

async function makeProject (a: FastifyInstance, cookie: string, name: string): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name }, cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

async function upload (
  a: FastifyInstance, cookie: string, projectId: string, kind: string,
  fileName: string, content: Buffer, contentType: string,
) {
  const boundary = '----adoptboundary1234567890'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return a.inject({
    method: 'POST', url: `/api/projects/${projectId}/assets?kind=${kind}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    cookies: { sj_session: cookie }, payload: Buffer.concat([head, content, tail]),
  })
}

const adopt = (a: FastifyInstance, cookie: string, id: string) =>
  a.inject({ method: 'POST', url: `/api/projects/${id}/adopt-srt`, cookies: { sj_session: cookie } })

describe('POST /api/projects/:id/adopt-srt', () => {
  it('未登录返回 401', async () => {
    const a = await makeApp()
    const res = await a.inject({ method: 'POST', url: '/api/projects/whatever/adopt-srt' })
    expect(res.statusCode).toBe(401)
  })

  it('项目不存在返回 404', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const res = await adopt(a, cookie, '没这个项目')
    expect(res.statusCode).toBe(404)
  })

  it('只有 SRT 没有配音 → 说「还差配音」，不是笼统的 400', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '缺配音')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('配音')
  })

  it('只有配音没有 SRT → 说「还差字幕」', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '缺字幕')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('字幕')
  })

  it('SRT 解析出 0 条 cue → 说清是格式问题', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '空字幕')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from('随便一段不是字幕的文字', 'utf8'), 'text/plain')
    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('SRT')
  })

  it('齐了就派生：ttsState=ready、subtitleMode=line、时长来自配音而不是最后一条 cue', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '自备完整')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')

    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { cueCount: number; durationMs: number; warning: string | null }
    expect(body.cueCount).toBe(2)
    // 配音 3 秒，最后一条 cue 只到 2.8 秒——成片必须跟音频走完整长度
    expect(body.durationMs).toBeGreaterThan(2900)
    expect(body.warning).toBe(null)

    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { ttsState: string; subtitleMode: string; ttsDurationMs: number; wordTimingsJson: string }
    expect(project.ttsState).toBe('ready')
    expect(project.subtitleMode).toBe('line')
    expect(project.ttsDurationMs).toBe(body.durationMs)
    expect(JSON.parse(project.wordTimingsJson)).toHaveLength(2)
  })

  it('落库的时长是整数毫秒——小数会让背景排布直接 500', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '整数时长')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    await adopt(a, cookie, id)

    const db = openUserDb('自备派生甲', LIST)
    const project = db.getProject(id)
    db.close()
    expect(project?.ttsDurationMs).not.toBe(null)
    expect(Number.isInteger(project?.ttsDurationMs)).toBe(true)
  })

  it('字幕明显超出配音时长 → 警告但不阻断（尾部留白是正常的，传错文件也可能）', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '超长字幕')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(2), 'audio/mpeg')
    const longSrt = `1
00:00:00,000 --> 00:00:01,000
开头

2
00:01:00,000 --> 00:01:05,000
一分钟后还在说话
`
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(longSrt, 'utf8'), 'text/plain')
    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().warning).toBe('string')
    expect(res.json().warning).toContain('字幕')
  })

  it('重复派生后项目状态不变——用户可能连点两次', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '幂等')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')

    const read = async () => {
      const p = (await a.inject({
        method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
      })).json() as Record<string, unknown>
      delete p.updatedAt   // 每次写都会动，与幂等无关
      return p
    }

    const first = (await adopt(a, cookie, id)).json()
    const afterFirst = await read()
    const second = (await adopt(a, cookie, id)).json()
    expect(await read()).toEqual(afterFirst)

    // 【响应里唯一合理的差异】：scriptFilled 说的是"这一次调用有没有回填
    // 文案"，第一次填过之后第二次当然是 false——它描述的是本次动作，
    // 不是最终状态，所以不该跟着幂等。其余字段必须一模一样。
    expect(second).toEqual({ ...first, scriptFilled: false })
  })

  it('把 SRT 正文反解码填进文案区，顺序与 cue 一致', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '回填文案')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')

    const res = await adopt(a, cookie, id)
    expect(res.json().scriptFilled).toBe(true)

    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { scriptText: string }
    expect(project.scriptText).toBe('第一句话\n第二句话')
  })

  it('cue 内部的显示断行被抹平——一句话不会在文案区被拆成两段', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '断行')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    const wrapped = `1
00:00:00,000 --> 00:00:02,000
这句话很长所以
被折成了两行

2
00:00:02,000 --> 00:00:03,000
下一句
`
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(wrapped, 'utf8'), 'text/plain')
    await adopt(a, cookie, id)

    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { scriptText: string }
    expect(project.scriptText).toBe('这句话很长所以被折成了两行\n下一句')
  })

  it('已有文案【绝不被静默覆盖】——那是不可逆的数据丢失', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '已有文案')
    await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { scriptText: '我自己写的原稿，不能被覆盖' }, cookies: { sj_session: cookie },
    })
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')

    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(200)
    expect(res.json().scriptFilled).toBe(false)

    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { scriptText: string; wordTimingsJson: string }
    expect(project.scriptText).toBe('我自己写的原稿，不能被覆盖')
    // 文案没覆盖，但字幕照样采用了——两件事互不影响
    expect(JSON.parse(project.wordTimingsJson)).toHaveLength(2)
  })

  it('【绝不改项目名】——项目名会被烧进成片当标题，任何状态后缀都会被观众看见', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '军师')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    await adopt(a, cookie, id)

    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { name: string }
    // 不是「军师（自备配音）」——buildAssForProject 会把项目名写成 Title
    // 那一行的正文，塞进名字的东西全程挂在画面顶上
    expect(project.name).toBe('军师')

    const ass = (await a.inject({
      method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie },
    })).body
    expect(ass).toContain('Title,,0,0,0,,军师')
    expect(ass).not.toContain('自备')
    expect(ass).not.toContain('SRT')
  })

  it('只有空白字符的文案算空，会被回填', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '空白文案')
    await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { scriptText: '   \n\n  ' }, cookies: { sj_session: cookie },
    })
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    expect((await adopt(a, cookie, id)).json().scriptFilled).toBe(true)
  })

  it('🔒 别人的项目 id 是 404', async () => {
    const a = await makeApp()
    const cookieA = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookieA, '甲的')
    const cookieB = await loginAs(a, '自备派生乙')
    expect((await adopt(a, cookieB, id)).statusCode).toBe(404)
  })
})

/**
 * 这一组是整个改动的核心断言：**自备路径接上去之后，下游一行都不用改**。
 *
 * 字幕派生接口、ASS、背景排布都只认 wordTimingsJson + ttsDurationMs，
 * 不关心这两样是 Azure 生成的还是用户传的。哪天有人在下游加了一个
 * 「只有 Azure 来的才算数」的分支，这一组会先炸。
 */
describe('下游零改动：自备路径建的项目在既有接口上照常工作', () => {
  async function readyProject (): Promise<{ a: FastifyInstance; cookie: string; id: string }> {
    const a = await makeApp()
    const cookie = await loginAs(a, '自备派生甲')
    const id = await makeProject(a, cookie, '自备下游')
    await upload(a, cookie, id, 'voice', 'a.mp3', await makeTestMp3(3), 'audio/mpeg')
    await upload(a, cookie, id, 'srt', 'a.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    const res = await adopt(a, cookie, id)
    expect(res.statusCode).toBe(200)
    return { a, cookie, id }
  }

  it('GET /subtitles 直接有内容，且与 cue 一一对应', async () => {
    const { a, cookie, id } = await readyProject()
    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/subtitles`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const lines = res.json().lines as { startMs: number; endMs: number; words: { text: string }[] }[]
    expect(lines).toHaveLength(2)
    expect(lines[0]?.words[0]?.text).toBe('第一句话')
    expect(lines[0]?.startMs).toBe(0)
    expect(lines[0]?.endMs).toBe(1200)
    expect(lines[1]?.startMs).toBe(1500)
  })

  it('GET /subtitles.ass 是整句模式：没有 \\kf 扫光', async () => {
    const { a, cookie, id } = await readyProject()
    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/subtitles.ass`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('第一句话')
    expect(res.body).not.toContain('\\kf')
  })

  it('GET /background-plan 照常排布，总长精确等于配音时长', async () => {
    const { a, cookie, id } = await readyProject()
    const res = await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { segments: { takeMs: number }[]; totalMs: number }
    const project = (await a.inject({
      method: 'GET', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })).json() as { ttsDurationMs: number }
    expect(body.totalMs).toBe(project.ttsDurationMs)
    expect(body.segments.length > 0).toBe(true)
    expect(body.segments.reduce((s, x) => s + x.takeMs, 0)).toBe(project.ttsDurationMs)
  })
})
