import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { bucketDir } from '../../src/library/paths.js'
import { assetDir } from '../../src/assets/storage.js'

const run = promisify(execFile)

let app: FastifyInstance
let dataDir = ''
afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = ''
})

const LIST = ['测试公式甲']

beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM export_jobs')
    db.raw.exec('DELETE FROM assets')
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

/** 配音时长：3 秒。够短、够跑完整条管线。 */
const VOICE_MS = 3000

async function makeVideo (path: string, seconds: number, size: string): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=${size}:r=25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ])
}

/** 【静音】配音。这样一旦成片里有声音，那声音只可能来自 BGM。 */
async function makeSilentVoice (path: string, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${seconds}`,
    '-t', String(seconds), path,
  ])
}

async function makeTone (path: string, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, path,
  ])
}

async function probeDuration (path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ])
  return Number(stdout.trim())
}

async function meanVolumeDb (path: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
  if (!m?.[1]) throw new Error('没能从 volumedetect 里读出平均音量')
  return Number(m[1])
}

function insertItem (
  db: LibraryDb, bucket: string, filename: string, durationMs: number,
): string {
  const id = `${bucket}/${filename}`
  db.raw.prepare(
    `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, bucket, filename, durationMs, 1000, '2026-07-19T00:00:00.000Z')
  return id
}

/**
 * ⚠️ 素材库指向【临时目录】，绝不碰真实的 data/library/——那是 8.5GB，
 * 地铁跑酷单文件就有 1GB。
 */
async function makeApp (opts: { seedLibrary?: boolean } = {}): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-formula-'))
  if (opts.seedLibrary !== false) {
    for (const b of ['1-开头', '2-常规', '3-地铁跑酷', '背景音乐']) {
      await mkdir(bucketDir(dataDir, b), { recursive: true })
    }
    // 三个桶三种分辨率——不归一化就 concat 不起来
    await makeVideo(join(bucketDir(dataDir, '1-开头'), '开头.mp4'), 2, '320x240')
    await makeVideo(join(bucketDir(dataDir, '2-常规'), '常规.mp4'), 2, '640x360')
    await makeVideo(join(bucketDir(dataDir, '3-地铁跑酷'), '跑酷.mp4'), 5, '426x240')
    await makeTone(join(bucketDir(dataDir, '背景音乐'), '一笑倾城 现言 甜文.wav'), 4)

    const lib = openLibraryDb(dataDir)
    insertItem(lib, '1-开头', '开头.mp4', 2000)
    insertItem(lib, '2-常规', '常规.mp4', 2000)
    insertItem(lib, '3-地铁跑酷', '跑酷.mp4', 5000)
    insertItem(lib, '背景音乐', '一笑倾城 现言 甜文.wav', 4000)
    lib.close()
  } else {
    openLibraryDb(dataDir).close()   // 建出空索引库
  }

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
  if (!c) throw new Error('登录没拿到会话 cookie')
  return c.value
}

/** 建一个配音就绪的项目，返回 id */
async function projectWithVoice (
  a: FastifyInstance, cookie: string, patch: { bgmLibraryId?: string } = {},
): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name: '公式项目' },
    cookies: { sj_session: cookie },
  })
  const id = res.json().id as string

  const voicePath = join(dataDir, 'voice.wav')
  await makeSilentVoice(voicePath, VOICE_MS / 1000)

  const db = openUserDb('测试公式甲', LIST)
  db.updateProject(id, { ttsState: 'ready', ttsDurationMs: VOICE_MS, ...patch })
  db.addAsset({
    projectId: id, kind: 'voice', path: voicePath,
    originalName: 'voice.wav', size: 1, durationMs: VOICE_MS,
  })
  db.close()
  return id
}

/** 提交导出并轮询到作业结束，返回落库的作业行 */
async function exportAndWait (
  a: FastifyInstance, cookie: string, id: string,
): Promise<{ status: string; outputPath: string | null; error: string | null; progress: number }> {
  const res = await a.inject({
    method: 'POST', url: `/api/projects/${id}/export`, cookies: { sj_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  const jobId = res.json().jobId as string

  for (let i = 0; i < 300; i++) {
    const db = openUserDb('测试公式甲', LIST)
    const job = db.getJob(jobId)
    db.close()
    if (job && (job.status === 'done' || job.status === 'error')) return job
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('导出作业超时未结束')
}

describe('导出 —— 公式模式的提交前校验', () => {
  it('没上传背景视频不再是错误——背景来自素材库', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/export`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('queued')
  }, 120_000)

  it('没配音时拒绝——背景长度由配音决定，必须先有配音', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const p = (await a.inject({
      method: 'POST', url: '/api/projects', payload: { name: '无配音' },
      cookies: { sj_session: cookie },
    })).json()
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${p.id}/export`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('配音')
  })

  it('素材库空时明说去扫库，而不是让 ffmpeg 报个看不懂的错', async () => {
    const a = await makeApp({ seedLibrary: false })
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/export`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('素材库')
  })
})

describe('导出 —— 公式模式端到端', () => {
  it('成片背景是素材库三段拼出来的，时长等于配音', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)

    const job = await exportAndWait(a, cookie, id)
    expect(job.error).toBe(null)
    expect(job.status).toBe('done')
    expect(job.outputPath).toBeTruthy()
    expect(job.progress).toBe(100)

    const out = job.outputPath ?? ''
    const dur = await probeDuration(out)
    expect(dur).toBeGreaterThan(VOICE_MS / 1000 - 0.3)
    expect(dur).toBeLessThan(VOICE_MS / 1000 + 0.3)

    /*
     * 【直接量背景轨本身】。只看成片时长是不够的：烧录那一步对背景视频加了
     * -stream_loop -1，哪怕背景轨只有 1 秒，成片照样是 3 秒——循环播放的
     * 单个片段，正是这个任务要消灭的东西。背景轨自己必须就有整条那么长。
     */
    const track = join(assetDir('测试公式甲', LIST, id), 'bg-track.mp4')
    const trackDur = await probeDuration(track)
    expect(trackDur).toBeGreaterThan(VOICE_MS / 1000 - 0.3)
    expect(trackDur).toBeLessThan(VOICE_MS / 1000 + 0.3)

    // 排布必须与前端预览接口给的那一份完全一致——所见即所得
    const plan = (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json()
    expect(plan.totalMs).toBe(VOICE_MS)
    // 三段式：开头 → 常规 → 地铁跑酷，顺序不能乱
    expect(plan.segments.map((s: { bucket: string }) => s.bucket))
      .toEqual(['1-开头', '2-常规', '3-地铁跑酷'])
  }, 180_000)

  it('没选 BGM 时成片是静音的（配音本身就是静音）', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)
    const job = await exportAndWait(a, cookie, id)
    expect(job.status).toBe('done')
    // 静音轨在 volumedetect 下是 -91dB 上下
    expect(await meanVolumeDb(job.outputPath ?? '')).toBeLessThan(-80)
  }, 180_000)

  it('选了素材库 BGM 时成片真的有背景音乐', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie, { bgmLibraryId: '背景音乐/一笑倾城 现言 甜文.wav' })
    const job = await exportAndWait(a, cookie, id)
    expect(job.error).toBe(null)
    expect(job.status).toBe('done')
    // 配音是静音的，所以只要有声音就一定来自素材库的 BGM
    expect(await meanVolumeDb(job.outputPath ?? '')).toBeGreaterThan(-60)
  }, 180_000)
})

describe('导出 —— 旧路径（已上传背景视频）不变', () => {
  it('有上传视频时照旧走单视频烧录，不碰素材库', async () => {
    // 素材库故意留空：旧路径根本不该去查它
    const a = await makeApp({ seedLibrary: false })
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)

    const uploaded = join(dataDir, 'uploaded.mp4')
    await makeVideo(uploaded, 2, '640x360')
    const db = openUserDb('测试公式甲', LIST)
    db.addAsset({
      projectId: id, kind: 'video', path: uploaded,
      originalName: 'uploaded.mp4', size: 1, durationMs: 2000,
    })
    db.close()

    const job = await exportAndWait(a, cookie, id)
    expect(job.error).toBe(null)
    expect(job.status).toBe('done')
    const dur = await probeDuration(job.outputPath ?? '')
    expect(dur).toBeGreaterThan(VOICE_MS / 1000 - 0.3)
  }, 180_000)

  it('上传了多个背景视频仍然明确拒绝', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试公式甲')
    const id = await projectWithVoice(a, cookie)
    const db = openUserDb('测试公式甲', LIST)
    for (const n of ['a.mp4', 'b.mp4']) {
      db.addAsset({
        projectId: id, kind: 'video', path: join(dataDir, n),
        originalName: n, size: 1, durationMs: 2000,
      })
    }
    db.close()
    const res = await a.inject({
      method: 'POST', url: `/api/projects/${id}/export`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('多余')
  }, 120_000)
})
