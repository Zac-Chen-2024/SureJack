import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAllowedExt, isAllowedUpload } from '../../src/assets/storage.js'

const run = promisify(execFile)

/**
 * 现场生成一段指定秒数的静音 mp3。
 *
 * 和 routes.test.ts 里的 makeTestVideo 同理：**不要改回引用 spikes/ 或
 * Material/ 下的文件**，那些目录被 .gitignore 挡着，只存在于开发者本机。
 */
async function makeTestMp3 (seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'byo-test-'))
  try {
    const path = join(dir, 'a.mp3')
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${seconds}`,
      '-t', String(seconds), path])
    return readFileSync(path)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const SRT = `1
00:00:00,000 --> 00:00:02,000
第一句话

2
00:00:02,000 --> 00:00:04,500
第二句话
`

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['自备甲', '自备乙']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

function multipartBody (fileName: string, content: Buffer, contentType: string) {
  const boundary = '----testboundary1234567890'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, payload: Buffer.concat([head, content, tail]) }
}

async function upload (
  a: FastifyInstance, cookie: string, projectId: string, kind: string,
  fileName: string, content: Buffer, contentType: string,
) {
  const { boundary, payload } = multipartBody(fileName, content, contentType)
  return a.inject({
    method: 'POST', url: `/api/projects/${projectId}/assets?kind=${kind}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    cookies: { sj_session: cookie }, payload,
  })
}

async function newProject (a: FastifyInstance, cookie: string): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name: '自备项目' },
    cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

describe('isAllowedExt / isAllowedUpload 扩到 voice / srt', () => {
  it('voice 接受常见配音音频扩展名', () => {
    expect(isAllowedExt('旁白.mp3', 'voice')).toBe(true)
    expect(isAllowedExt('旁白.wav', 'voice')).toBe(true)
    expect(isAllowedExt('旁白.m4a', 'voice')).toBe(true)
    expect(isAllowedExt('旁白.aac', 'voice')).toBe(true)
  })

  it('voice 拒绝视频和其它扩展名', () => {
    expect(isAllowedExt('旁白.mp4', 'voice')).toBe(false)
    expect(isAllowedExt('旁白.txt', 'voice')).toBe(false)
  })

  it('srt 只接受 .srt', () => {
    expect(isAllowedExt('字幕.srt', 'srt')).toBe(true)
    expect(isAllowedExt('字幕.SRT', 'srt')).toBe(true)
    expect(isAllowedExt('字幕.ass', 'srt')).toBe(false)
    expect(isAllowedExt('字幕.vtt', 'srt')).toBe(false)
    expect(isAllowedExt('字幕.txt', 'srt')).toBe(false)
  })

  it('export 仍然不接受上传', () => {
    expect(isAllowedExt('成片.mp4', 'export')).toBe(false)
    expect(isAllowedUpload('video/mp4', '成片.mp4', 'export')).toBe(false)
  })

  it('srt 只看扩展名，不看 MIME——浏览器对 .srt 报的 MIME 各不相同', () => {
    // Chrome 报 application/x-subrip，Firefox 报 application/octet-stream，
    // 有的干脆是空串。按 MIME 拒绝会把正常用户挡在门外。
    expect(isAllowedUpload('application/x-subrip', 'a.srt', 'srt')).toBe(true)
    expect(isAllowedUpload('application/octet-stream', 'a.srt', 'srt')).toBe(true)
    expect(isAllowedUpload('text/plain', 'a.srt', 'srt')).toBe(true)
    expect(isAllowedUpload('', 'a.srt', 'srt')).toBe(true)
    // 但扩展名不对依然拒
    expect(isAllowedUpload('application/x-subrip', 'a.exe', 'srt')).toBe(false)
  })

  it('voice 同时校验 MIME 与扩展名', () => {
    expect(isAllowedUpload('audio/mpeg', 'a.mp3', 'voice')).toBe(true)
    expect(isAllowedUpload('video/mp4', 'a.mp3', 'voice')).toBe(false)
  })
})

describe('上传 voice / srt', () => {
  it('四种 kind 都被接受（video/bgm/voice/srt）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    const mp3 = await makeTestMp3(2)

    const voice = await upload(app, cookie, id, 'voice', '旁白.mp3', mp3, 'audio/mpeg')
    expect(voice.statusCode).toBe(200)
    expect(voice.json().kind).toBe('voice')

    const bgm = await upload(app, cookie, id, 'bgm', '配乐.mp3', mp3, 'audio/mpeg')
    expect(bgm.statusCode).toBe(200)
    expect(bgm.json().kind).toBe('bgm')

    const srt = await upload(app, cookie, id, 'srt', '字幕.srt', Buffer.from(SRT, 'utf8'), 'application/x-subrip')
    expect(srt.statusCode).toBe(200)
    expect(srt.json().kind).toBe('srt')
  })

  it('上传的配音探测到时长，且是整数毫秒', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    const res = await upload(app, cookie, id, 'voice', '旁白.mp3', await makeTestMp3(3), 'audio/mpeg')
    expect(res.statusCode).toBe(200)
    const durationMs = res.json().durationMs as number
    expect(durationMs).toBeGreaterThan(2500)
    expect(Number.isInteger(durationMs)).toBe(true)
  })

  it('srt 不跑 ffprobe：durationMs 为 null，且纯文本内容不会被判成坏文件', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    // 这段文本 ffprobe 一定解不动。若实现对 srt 也探测时长，这里会 400。
    const res = await upload(app, cookie, id, 'srt', '字幕.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    expect(res.statusCode).toBe(200)
    expect(res.json().durationMs).toBe(null)
  })

  it('错误扩展名被拒，且说清接受什么', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)

    const badVoice = await upload(app, cookie, id, 'voice', '旁白.mp4', Buffer.from('x'), 'audio/mpeg')
    expect(badVoice.statusCode).toBe(400)
    expect(badVoice.json().error).toContain('mp3')

    const badSrt = await upload(app, cookie, id, 'srt', '字幕.vtt', Buffer.from(SRT, 'utf8'), 'text/plain')
    expect(badSrt.statusCode).toBe(400)
    expect(badSrt.json().error).toContain('srt')
  })

  it('未知 kind 仍被拒', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    const res = await upload(app, cookie, id, 'export', 'x.mp4', Buffer.from('x'), 'video/mp4')
    expect(res.statusCode).toBe(400)
  })

  it('重复传同一种 kind 是替换不是追加——配音和字幕各只能有一份', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    const mp3 = await makeTestMp3(2)

    await upload(app, cookie, id, 'voice', '旧配音.mp3', mp3, 'audio/mpeg')
    await upload(app, cookie, id, 'srt', '旧字幕.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    await upload(app, cookie, id, 'voice', '新配音.mp3', mp3, 'audio/mpeg')
    await upload(app, cookie, id, 'srt', '新字幕.srt', Buffer.from(SRT, 'utf8'), 'text/plain')

    const list = (await app.inject({
      method: 'GET', url: `/api/projects/${id}/assets`, cookies: { sj_session: cookie },
    })).json() as { kind: string; originalName: string }[]

    const voices = list.filter((a) => a.kind === 'voice')
    const srts = list.filter((a) => a.kind === 'srt')
    expect(voices).toHaveLength(1)
    expect(srts).toHaveLength(1)
    expect(voices[0]?.originalName).toBe('新配音.mp3')
    expect(srts[0]?.originalName).toBe('新字幕.srt')
  })

  it('背景视频重复上传【仍然是追加】——多段背景是正常用法，不能一起改成替换', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '自备甲')
    const id = await newProject(app, cookie)
    const mp3 = await makeTestMp3(1)
    await upload(app, cookie, id, 'bgm', 'a.mp3', mp3, 'audio/mpeg')
    await upload(app, cookie, id, 'bgm', 'b.mp3', mp3, 'audio/mpeg')
    const list = (await app.inject({
      method: 'GET', url: `/api/projects/${id}/assets`, cookies: { sj_session: cookie },
    })).json() as { kind: string }[]
    expect(list.filter((a) => a.kind === 'bgm')).toHaveLength(2)
  })

  it('🔒 传到别人的项目上是 404', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '自备甲')
    const id = await newProject(app, cookieA)
    const cookieB = await loginAs(app, '自备乙')
    const res = await upload(app, cookieB, id, 'srt', '字幕.srt', Buffer.from(SRT, 'utf8'), 'text/plain')
    expect(res.statusCode).toBe(404)
  })
})
