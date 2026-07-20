import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { openUserDb } from '../../src/db/user-db.js'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { bucketDir } from '../../src/library/paths.js'
import { assetDir } from '../../src/assets/storage.js'
import { BG_TRACK_FILE } from '../../src/compose/prebuild.js'
import type { synthesizeLong } from '../../src/tts/index.js'

const run = promisify(execFile)

const LIST = ['测试预拼甲']
/** 配音时长。短、够跑完整条管线。 */
const VOICE_MS = 3000

let app: FastifyInstance
let dataDir = ''

beforeEach(() => {
  for (const name of LIST) {
    const db = openUserDb(name, LIST)
    db.raw.exec('DELETE FROM export_jobs')
    db.raw.exec('DELETE FROM assets')
    db.raw.exec('DELETE FROM projects')
    db.close()
  }
})

afterEach(async () => {
  await app?.close()
  vi.unstubAllEnvs()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = ''
})

async function makeVideo (path: string, seconds: number, size: string): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=${size}:r=25`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
  ])
}

async function makeSilentVoice (path: string, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${seconds}`,
    '-t', String(seconds), path,
  ])
}

async function probeDuration (path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ])
  return Number(stdout.trim())
}

function insertItem (db: LibraryDb, bucket: string, filename: string, durationMs: number): void {
  db.raw.prepare(
    `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${bucket}/${filename}`, bucket, filename, durationMs, 1000, '2026-07-19T00:00:00.000Z')
}

/** 假合成：不打 Azure、不落盘。预拼只看 ttsDurationMs，够用。 */
const fakeSynth: typeof synthesizeLong = async (opts) => ({
  audioPath: opts.outPath,
  words: [{ text: '他', offsetMs: 0, durationMs: VOICE_MS, isPunctuation: false }],
  durationMs: VOICE_MS,
  segmentCount: 1,
})

/**
 * ⚠️ 素材库指向【临时目录】，绝不碰真实的 data/library/。
 */
async function makeApp (): Promise<FastifyInstance> {
  dataDir = await mkdtemp(join(tmpdir(), 'sj-prebuilt-'))
  for (const b of ['1-开头', '2-常规', '3-地铁跑酷']) {
    await mkdir(bucketDir(dataDir, b), { recursive: true })
  }
  await makeVideo(join(bucketDir(dataDir, '1-开头'), '开头.mp4'), 2, '320x240')
  await makeVideo(join(bucketDir(dataDir, '2-常规'), '常规.mp4'), 2, '640x360')
  await makeVideo(join(bucketDir(dataDir, '3-地铁跑酷'), '跑酷.mp4'), 5, '426x240')

  const lib = openLibraryDb(dataDir)
  insertItem(lib, '1-开头', '开头.mp4', 2000)
  insertItem(lib, '2-常规', '常规.mp4', 2000)
  insertItem(lib, '3-地铁跑酷', '跑酷.mp4', 5000)
  lib.close()

  const a = buildServer({
    authDbPath: ':memory:', whitelist: LIST,
    cookieSecret: 'test-secret-32-chars-long-abcdefg',
    libraryDataDir: dataDir, synthesizeLong: fakeSynth,
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

async function makeProject (a: FastifyInstance, cookie: string): Promise<string> {
  const res = await a.inject({
    method: 'POST', url: '/api/projects', payload: { name: '预拼项目' },
    cookies: { sj_session: cookie },
  })
  return res.json().id as string
}

/** 直接把项目改成「配音就绪」，不经过任何路由——用于只测预拼本身的用例 */
async function markVoiceReady (id: string): Promise<void> {
  const voicePath = join(dataDir, 'voice.wav')
  await makeSilentVoice(voicePath, VOICE_MS / 1000)
  const db = openUserDb('测试预拼甲', LIST)
  db.updateProject(id, { ttsState: 'ready', ttsDurationMs: VOICE_MS })
  db.addAsset({
    projectId: id, kind: 'voice', path: voicePath,
    originalName: 'voice.wav', size: 1, durationMs: VOICE_MS,
  })
  db.close()
}

interface BgInfo { state: string; assetId: string | null }

async function bgStatus (a: FastifyInstance, cookie: string, id: string): Promise<BgInfo> {
  const res = await a.inject({
    method: 'GET', url: `/api/projects/${id}/bg-track`, cookies: { sj_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as BgInfo
}

/** 轮询到背景轨不再是 building。机器负载高，窗口给宽一点。 */
async function waitBgTrack (a: FastifyInstance, cookie: string, id: string): Promise<BgInfo> {
  for (let i = 0; i < 900; i++) {
    const info = await bgStatus(a, cookie, id)
    if (info.state !== 'building') return info
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('背景轨预拼超时未结束')
}

async function exportAndWait (
  a: FastifyInstance, cookie: string, id: string,
): Promise<{ status: string; outputPath: string | null; error: string | null }> {
  const res = await a.inject({
    method: 'POST', url: `/api/projects/${id}/export`, cookies: { sj_session: cookie },
  })
  expect(res.statusCode).toBe(200)
  const jobId = res.json().jobId as string
  for (let i = 0; i < 900; i++) {
    const db = openUserDb('测试预拼甲', LIST)
    const job = db.getJob(jobId)
    db.close()
    if (job && (job.status === 'done' || job.status === 'error')) return job
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('导出作业超时未结束')
}

function trackPathOf (id: string): string {
  return join(assetDir('测试预拼甲', LIST, id), BG_TRACK_FILE)
}

describe('背景轨预拼 —— 配音一就绪就在后台拼好', () => {
  it('生成配音之后自动拼出背景轨，并登记成可播放的素材', async () => {
    const a = await makeApp()
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake-key')
    vi.stubEnv('AZURE_SPEECH_REGION', 'fake-region')
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await a.inject({
      method: 'PATCH', url: `/api/projects/${id}`,
      payload: { scriptText: '他站在门口，一动不动。' }, cookies: { sj_session: cookie },
    })

    // 【用户什么都没多做】——只点了「生成配音」
    const voice = await a.inject({
      method: 'POST', url: `/api/projects/${id}/voice`, cookies: { sj_session: cookie },
    })
    expect(voice.statusCode).toBe(200)

    const info = await waitBgTrack(a, cookie, id)
    expect(info.state).toBe('ready')
    expect(info.assetId).toBeTruthy()

    // 轨真的在盘上，且不短于配音——短了烧录时会从头循环
    const dur = await probeDuration(trackPathOf(id))
    expect(dur).toBeGreaterThanOrEqual(VOICE_MS / 1000 - 0.05)

    // 【预览要能通过 /api/assets/<id> 播它】，这是 Task 3 的地基
    const res = await a.inject({
      method: 'GET', url: `/api/assets/${info.assetId ?? ''}`, cookies: { sj_session: cookie },
    })
    /*
     * 【失败时要说清是哪种 404】。这里有两个完全不同的原因：
     * 「素材不存在」（记录被换掉了，id 不稳定）和「素材文件已丢失」
     * （记录在但盘上没文件）。只断言状态码的话，两者长得一模一样——
     * 这条测试随机红过五次，每次都因为看不出是哪个而只能猜"大概是抢CPU"。
     */
    if (res.statusCode !== 200) {
      throw new Error(`取背景轨素材失败：${res.statusCode} ${res.body}`)
    }
    expect(res.headers['content-type']).toContain('video/mp4')
    // Range 必须支持，否则浏览器拖进度条要把整条轨下完
    expect(res.headers['accept-ranges']).toBe('bytes')
  }, 300_000)

  it('配音还没好时说 none，不会凭空拼一条', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    expect((await bgStatus(a, cookie, id)).state).toBe('none')
  }, 120_000)

  it('别人的项目 / 不存在的项目一律 404', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const res = await a.inject({
      method: 'GET', url: '/api/projects/00000000-0000-0000-0000-000000000000/bg-track',
      cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(404)
  }, 120_000)

  it('未登录拿不到状态', async () => {
    const a = await makeApp()
    const res = await a.inject({ method: 'GET', url: '/api/projects/x/bg-track' })
    expect(res.statusCode).toBe(401)
  }, 120_000)

  it('老项目（配音早就有了、没触发过预拼）问一次状态就会补拼上', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)   // 绕过路由，模拟上线前就存在的数据

    expect((await bgStatus(a, cookie, id)).state).toBe('building')
    expect((await waitBgTrack(a, cookie, id)).state).toBe('ready')
  }, 300_000)
})

describe('背景轨预拼 —— 排布变了要重拼', () => {
  it('素材库扫进新素材后，旧轨作废、重新拼一条', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)
    expect((await waitBgTrack(a, cookie, id)).state).toBe('ready')

    const before = await stat(trackPathOf(id))
    const planBefore = (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json()

    /*
     * 重扫素材库：常规桶那个文件被换成了另一个。background.ts 里记着
     * 这个已知取舍——排布不落库、每次现算，所以库的内容一变，已有项目
     * 的排布跟着变。
     *
     * 【故意用"换掉"而不是"添几个"】：多加两个文件不一定改变一条 3 秒
     * 片子的排布（Fisher-Yates 完全可能还是抽中原来那个），那样这条用例
     * 就在测一个没发生的变化。换掉则必然改变段里的 itemId。
     */
    await makeVideo(join(bucketDir(dataDir, '2-常规'), '常规新.mp4'), 2, '640x360')
    const lib = openLibraryDb(dataDir)
    lib.raw.prepare('DELETE FROM library_items WHERE id = ?').run('2-常规/常规.mp4')
    insertItem(lib, '2-常规', '常规新.mp4', 2000)
    lib.close()

    const planAfter = (await a.inject({
      method: 'GET', url: `/api/projects/${id}/background-plan`, cookies: { sj_session: cookie },
    })).json()
    // 【先确认前提】：排布真的变了，否则下面测的就不是"重拼"了
    expect(JSON.stringify(planAfter.segments)).not.toBe(JSON.stringify(planBefore.segments))

    // 指纹对不上 → 不能再报 ready
    expect((await bgStatus(a, cookie, id)).state).toBe('building')
    expect((await waitBgTrack(a, cookie, id)).state).toBe('ready')

    const after = await stat(trackPathOf(id))
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs)
  }, 300_000)
})

describe('背景轨预拼 —— 导出直接用，不再现拼', () => {
  it('指纹对得上时导出跳过生成，轨一个字节都没重写', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)
    expect((await waitBgTrack(a, cookie, id)).state).toBe('ready')

    const before = await stat(trackPathOf(id))
    const job = await exportAndWait(a, cookie, id)
    expect(job.error).toBe(null)
    expect(job.status).toBe('done')

    const after = await stat(trackPathOf(id))
    // 【mtime 没动 = 真的复用了】。只看成片对不对是分不出来的：
    // 重拼一遍也能出正确的成片，只是白花了那几十秒。
    expect(after.mtimeMs).toBe(before.mtimeMs)

    const dur = await probeDuration(job.outputPath ?? '')
    expect(dur).toBeGreaterThan(VOICE_MS / 1000 - 0.3)
    expect(dur).toBeLessThan(VOICE_MS / 1000 + 0.3)
  }, 300_000)

  it('预拼失败 / 留下一条坏轨时，导出照样成片——绝不被一个优化拖垮', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)

    /*
     * 造一个最恶劣的现场：轨文件是垃圾，指纹还对不上。
     * 这覆盖了预拼中途被杀、素材库被重扫、旁挂文件被改坏等一大类情况。
     */
    const dir = assetDir('测试预拼甲', LIST, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, BG_TRACK_FILE), '这不是一个 mp4')
    await writeFile(join(dir, 'bg-track.json'), JSON.stringify({ fingerprint: '陈旧的指纹' }))

    const job = await exportAndWait(a, cookie, id)
    expect(job.error).toBe(null)
    expect(job.status).toBe('done')
    const dur = await probeDuration(job.outputPath ?? '')
    expect(dur).toBeGreaterThan(VOICE_MS / 1000 - 0.3)
    expect(dur).toBeLessThan(VOICE_MS / 1000 + 0.3)
  }, 300_000)

  it('导出时现拼的轨也会记上指纹，下一次就能复用', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)

    // 不等预拼，直接导出——第一次必然是现拼
    const first = await exportAndWait(a, cookie, id)
    expect(first.status).toBe('done')

    const stamp = JSON.parse(await readFile(
      join(assetDir('测试预拼甲', LIST, id), 'bg-track.json'), 'utf-8'))
    expect(typeof stamp.fingerprint).toBe('string')

    const before = await stat(trackPathOf(id))
    const second = await exportAndWait(a, cookie, id)
    expect(second.status).toBe('done')
    expect((await stat(trackPathOf(id))).mtimeMs).toBe(before.mtimeMs)
  }, 300_000)
})

describe('背景轨预拼 —— 拼不出来时说清是 error', () => {
  it('素材文件没了 → 状态是 error，而不是永远卡在 building', async () => {
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)

    // 索引还在（所以排布算得出来），文件没了 → ffmpeg 必然失败
    for (const [b, f] of [['1-开头', '开头.mp4'], ['2-常规', '常规.mp4'], ['3-地铁跑酷', '跑酷.mp4']]) {
      await rm(join(bucketDir(dataDir, b ?? ''), f ?? ''), { force: true })
    }

    const info = await waitBgTrack(a, cookie, id)
    /*
     * 【必须是 error，不能是 building】。卡在 building 的话预览会永远显示
     * 「背景生成中…」，用户看着转圈等一个永远不会来的东西。
     */
    expect(info.state).toBe('error')
    expect(info.assetId).toBe(null)
  }, 300_000)
})

describe('磁盘账 —— 背景轨常驻，但删项目时一并清掉', () => {
  it('删项目会把整个素材目录（含 750MB 级的背景轨）删干净', async () => {
    /*
     * 背景轨约 65MB/分钟，一条 11.5 分钟的片子就是 750MB，而它是常驻的
     * ——预览随时要播。删项目不删文件的话磁盘只涨不落，当前空间撑三条。
     */
    const a = await makeApp()
    const cookie = await loginAs(a, '测试预拼甲')
    const id = await makeProject(a, cookie)
    await markVoiceReady(id)
    expect((await waitBgTrack(a, cookie, id)).state).toBe('ready')

    const dir = assetDir('测试预拼甲', LIST, id)
    expect((await stat(join(dir, BG_TRACK_FILE))).size).toBeGreaterThan(0)

    const res = await a.inject({
      method: 'DELETE', url: `/api/projects/${id}`, cookies: { sj_session: cookie },
    })
    expect(res.statusCode).toBe(200)
    await expect(stat(dir)).rejects.toThrow()
  }, 300_000)
})

describe('背景轨素材的 id 必须稳定', () => {
  /*
   * 这条轨的 id 会被【拿在手里】：前端的 <video src="/api/assets/<id>">
   * 一旦拿到就一直用着。以前重新登记是「删了重插」，于是每次重拼都换一个
   * 新 id，正在播的那个 URL 当场 404——而重新登记是后台自己发生的，
   * 用户什么都没做画面就黑了。
   *
   * 同一个 bug 也让上面那条端到端测试随机红：先读到 id，再取素材，
   * 中间只要有另一条预拼作业完成，手里那个 id 就没了。
   */
  it('重新登记同一条轨，id 不能变', () => {
    const db = openUserDb('测试预拼甲', LIST)
    try {
      const project = db.createProject('id稳定性')
      const path = '/tmp/bg-track.mp4'

      db.addAsset({
        projectId: project.id, kind: 'bgtrack', path,
        originalName: 'bg-track.mp4', size: 0, durationMs: 3000,
      })
      const first = db.listAssets(project.id, 'bgtrack')[0]!

      // 就地更新（registerTrackAsset 现在走的路）
      db.updateAsset(first.id, { path, durationMs: 5000 })
      const after = db.listAssets(project.id, 'bgtrack')

      expect(after).toHaveLength(1)
      expect(after[0]!.id).toBe(first.id)      // ← 核心：id 没变
      expect(after[0]!.durationMs).toBe(5000)  // 内容确实更新了
    } finally {
      db.close()
    }
  })
})
