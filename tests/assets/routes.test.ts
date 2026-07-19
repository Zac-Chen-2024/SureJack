import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 现场生成一段指定秒数的小视频，返回它的字节。
 *
 * 【不要改回读 spikes/ 或 Material/ 下的文件】：那些目录都被 .gitignore
 * 挡着，只存在于开发者本机。测试引用它们的话，别人克隆这个仓库跑
 * npm test 就是红的，而在本机上永远发现不了——这个问题正是子代理在
 * 干净的 git worktree 里跑测试时才暴露出来的。
 */
async function makeTestVideo (seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'asset-test-'))
  try {
    const path = join(dir, 'v.mp4')
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=64x64:d=${seconds}`,
      '-pix_fmt', 'yuv420p', path])
    return readFileSync(path)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试上传甲', '测试上传乙']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

async function loginAs (a: FastifyInstance, name: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { name, password: 'pass1234' } })
  return res.cookies.find((c) => c.name === 'sj_session')!.value
}

/** 构造一个 multipart 请求体 */
function multipartBody (fieldName: string, fileName: string, content: Buffer, contentType: string) {
  const boundary = '----testboundary1234567890'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, payload: Buffer.concat([head, content, tail]) }
}

describe('上传接口', () => {
  it('未登录上传返回 401', async () => {
    app = await makeApp()
    const { boundary, payload } = multipartBody('file', 'a.mp4', Buffer.from('x'), 'video/mp4')
    const res = await app.inject({
      method: 'POST', url: '/api/projects/whatever/assets?kind=video',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('拒绝不支持的格式（早失败）', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试上传甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
    const { boundary, payload } = multipartBody('file', 'evil.exe', Buffer.from('MZ'), 'application/x-executable')
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${p.id}/assets?kind=video`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: { sj_session: cookie }, payload,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('格式')
  })

  it('上传真实小视频后能列出来，且探测到时长', async () => {
    app = await makeApp()
    const cookie = await loginAs(app, '测试上传甲')
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目' }, cookies: { sj_session: cookie } })).json()
    // 现场生成 6 秒小视频。不引用 spikes/karaoke/bg.mp4——那个文件被
    // .gitignore 挡着，只存在于开发者本机，别人克隆后这条测试必红。
    const video = await makeTestVideo(6)
    const { boundary, payload } = multipartBody('file', 'bg.mp4', video, 'video/mp4')
    const up = await app.inject({
      method: 'POST', url: `/api/projects/${p.id}/assets?kind=video`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: { sj_session: cookie }, payload,
    })
    expect(up.statusCode).toBe(200)
    expect(up.json().kind).toBe('video')
    expect(up.json().durationMs).toBeGreaterThan(5000)   // 6 秒的视频

    const list = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/assets`, cookies: { sj_session: cookie } })
    expect(list.json()).toHaveLength(1)
  })

  it('🔒 拿不到别人项目的素材列表', async () => {
    app = await makeApp()
    const cookieA = await loginAs(app, '测试上传甲')
    const pA = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '甲的' }, cookies: { sj_session: cookieA } })).json()
    const cookieB = await loginAs(app, '测试上传乙')
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pA.id}/assets`, cookies: { sj_session: cookieB } })
    expect(res.statusCode).toBe(404)   // 乙的库里没这个项目
  })
})
