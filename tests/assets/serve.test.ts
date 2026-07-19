import { describe, it, expect, afterEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { parseRange, playbackMimeFor } from '../../src/assets/storage.js'

let app: FastifyInstance
afterEach(async () => { await app?.close() })

const LIST = ['测试回放甲', '测试回放乙']

async function makeApp () {
  const a = buildServer({ authDbPath: ':memory:', whitelist: LIST, cookieSecret: 'test-secret-32-chars-long-abcdefg' })
  await a.ready()
  return a
}

describe('素材回放接口 GET /api/assets/:assetId', () => {
  it('未登录返回 401', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/assets/whatever' })
    expect(res.statusCode).toBe(401)
  })

  it('别人的（或不存在的）素材 id 一律 404', async () => {
    app = await makeApp()
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: '测试回放甲', password: 'pass1234' } })
    const cookie = login.cookies.find((c) => c.name === 'sj_session')!.value
    const res = await app.inject({ method: 'GET', url: '/api/assets/nope', cookies: { sj_session: cookie } })
    expect(res.statusCode).toBe(404)
  })
})

describe('字体接口 GET /api/fonts/subtitle.ttc', () => {
  /**
   * 前端 JASSUB 用不了系统字体，字体必须由服务端喂。这个接口直接吐
   * ffmpeg 烧录用的那一个文件——"两端同一个渲染器"的前提是两端同一份字形。
   */
  it('返回字体文件本身，并带长期缓存头', async () => {
    app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/fonts/subtitle.ttc' })
    // 机器上没装 fonts-noto-cjk 时给的是明确的 500 而不是 404/静默空文件
    if (res.statusCode === 500) {
      expect(res.json().error).toContain('fonts-noto-cjk')
      return
    }
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('font/collection')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1_000_000)
  })
})

describe('playbackMimeFor', () => {
  it('按扩展名给出可播放的 MIME', () => {
    expect(playbackMimeFor('/a/b/c.mp4')).toBe('video/mp4')
    expect(playbackMimeFor('/a/b/c.MP3')).toBe('audio/mpeg')
    expect(playbackMimeFor('/a/b/c.mov')).toBe('video/quicktime')
  })

  it('认不出的扩展名回 octet-stream，不瞎猜', () => {
    expect(playbackMimeFor('/a/b/c.xyz')).toBe('application/octet-stream')
    expect(playbackMimeFor('/a/b/noext')).toBe('application/octet-stream')
  })
})

describe('parseRange', () => {
  it('没有 Range 头时返回 null（回整文件）', () => {
    expect(parseRange(undefined, 100)).toBeNull()
  })

  it('bytes=0-99 解析成闭区间', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
  })

  it('bytes=500- 一直到文件末尾', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('bytes=-200 取最后 200 字节', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })

  it('end 超出文件末尾时夹到末尾，不是报错', () => {
    expect(parseRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 })
  })

  /** start 越界必须回 416，不能悄悄夹成一个能读的区间——那会喂给播放器错误的数据 */
  it('start 越界 / 区间倒挂返回 invalid', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=800-700', 1000)).toBe('invalid')
    expect(parseRange('bytes=-0', 1000)).toBe('invalid')
  })

  it('多区间等看不懂的写法退回整文件，不崩', () => {
    expect(parseRange('bytes=0-50, 100-150', 1000)).toBeNull()
    expect(parseRange('items=0-50', 1000)).toBeNull()
  })
})
