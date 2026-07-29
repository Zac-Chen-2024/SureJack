import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { assetDir } from '../../src/assets/storage.js'
import { writeStamp } from '../../src/compose/stamp.js'
import {
  sweepFilms, resolveFilm, filmInfo, FILM_FILE, FILM_STAMP_FILE,
  FILM_MASTER_FILE, MASTER_STAMP_FILE, type FilmDeps,
} from '../../src/compose/film.js'

/**
 * 开机补合扫描。
 *
 * 这一扫存在的理由是【队列活在进程内存里】：进程一重启，正在跑的合成
 * 凭空消失，而没有任何事件会再次发生。线上真出过——重启一次，成片停在
 * 11MB 再没动过，只能靠用户碰巧打开页面才被前端轮询救回来。
 *
 * 所以这里最要紧的断言不是"缺的能补上"，而是【哪些绝不能重排】：
 * 已经好了的、失败过的，开机时都不该再跑一遍 ffmpeg。
 */

const LIST = ['测试补合甲']
const USER = LIST[0]!

/** 记下被排了哪些活，但一条都不真跑 */
function fakeQueue () {
  const enqueued: string[] = []
  return {
    enqueued,
    /** 队列里认不认识这个 jobId。默认一律不认——这就是"重启之后"的样子 */
    known: new Map<string, { status: string; progress: number }>(),
    deps (dataDir: string): FilmDeps {
      return {
        whitelist: LIST,
        libraryDataDir: dataDir,
        queue: {
          enqueue: (jobId: string) => { enqueued.push(jobId) },
          on: () => {},
          snapshot: (jobId: string) => this.known.get(jobId) ?? null,
        },
      } as unknown as FilmDeps
    },
  }
}

let dataDir = ''
let q = fakeQueue()

beforeEach(async () => {
  const db = openUserDb(USER, LIST)
  db.raw.exec('DELETE FROM export_jobs')
  db.raw.exec('DELETE FROM assets')
  db.raw.exec('DELETE FROM projects')
  db.close()
  dataDir = await mkdtemp(join(tmpdir(), 'sweep-'))
  q = fakeQueue()
})

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = ''
  await rm(assetDir(USER, LIST, 'x').replace(/\/x$/, ''), { recursive: true, force: true })
})

/**
 * 造一个「配音就绪 + 自备背景视频」的项目。
 * 走自备视频这条路，是为了让这个测试完全不依赖素材库——
 * 它要验的是扫描的判定，不是背景排布。
 */
async function makeReadyProject (name: string): Promise<string> {
  const db = openUserDb(USER, LIST)
  const p = db.createProject(name)
  db.updateProject(p.id, { scriptText: '测试文案', ttsState: 'ready', ttsDurationMs: 3000 })
  const dir = assetDir(USER, LIST, p.id)
  await mkdir(dir, { recursive: true })
  const voice = join(dir, 'voice.mp3')
  const video = join(dir, 'bg.mp4')
  await writeFile(voice, 'x')
  await writeFile(video, 'x')
  db.addAsset({ projectId: p.id, kind: 'voice', path: voice, originalName: 'v.mp3', size: 1 })
  db.addAsset({ projectId: p.id, kind: 'video', path: video, originalName: 'b.mp4', size: 1 })
  db.close()
  return p.id
}

/** 当前这份输入的指纹——写"已经做好了"的戳时要对得上 */
function fingerprintOf (deps: FilmDeps, projectId: string): string {
  const r = resolveFilm(deps, USER, projectId)
  if (!r.ok) throw new Error('用例的前置条件就没成立：' + r.error)
  return r.film.fingerprint
}

describe('开机补合扫描', () => {
  it('该有成片却没有 —— 排上队', async () => {
    const deps = q.deps(dataDir)
    await makeReadyProject('缺片子的')

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual(['缺片子的'])
    // 2 条：背景轨预拼 + 成片本身。队列是 FIFO，预拼必须排在成片前面
    expect(q.enqueued).toHaveLength(2)
  })

  it('【已经合好的绝不重做】否则每次重启都把所有片子重跑一遍', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('已经好了的')
    const dir = assetDir(USER, LIST, id)
    await writeFile(join(dir, FILM_FILE), 'pretend-mp4')
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint: fingerprintOf(deps, id), status: 'done', jobId: 'old-job',
    })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual([])
    expect(q.enqueued).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('【失败过的不自动重试】开机跑一堆注定失败的 ffmpeg 只会把机器占死', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('上次失败的')
    const dir = assetDir(USER, LIST, id)
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint: fingerprintOf(deps, id), status: 'error', error: '素材坏了', jobId: 'j-err',
    })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual([])
    expect(q.enqueued).toEqual([])
  })

  /*
   * 这一条就是线上那个 bug 的复现：戳上写着 building、jobId 也在，
   * 但那条作业已经随进程一起没了。只信戳的话这个项目永远醒不过来。
   */
  it('【戳写着 building 但队列里没有 —— 必须重排】这正是进程被杀留下的样子', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('重启时被杀的')
    const dir = assetDir(USER, LIST, id)
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint: fingerprintOf(deps, id), status: 'building', jobId: '已经不存在的作业',
    })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual(['重启时被杀的'])
  })

  it('【队列里真在跑的不插队】否则两条 ffmpeg 抢同一个输出文件', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('正在跑的')
    const dir = assetDir(USER, LIST, id)
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint: fingerprintOf(deps, id), status: 'building', jobId: 'j-live',
    })
    q.known.set('j-live', { status: 'running', progress: 42 })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual([])
    expect(q.enqueued).toEqual([])
  })

  it('没配音的项目跳过，不排注定失败的活', async () => {
    const db = openUserDb(USER, LIST)
    db.createProject('还没配音的')
    db.close()

    const r = await sweepFilms(q.deps(dataDir), LIST)

    expect(r.enqueued).toEqual([])
  })

  it('一个用户的库炸了，不该让整扫停下', async () => {
    const deps = q.deps(dataDir)
    await makeReadyProject('好的那个')

    // 白名单里混进一个根本没有库的用户
    const r = await sweepFilms(deps, ['查无此人', ...LIST])

    expect(r.enqueued).toEqual(['好的那个'])
  })
})

describe('无 BGM 的成片 = 母带，filmInfo 必须认它', () => {
  /*
   * 母带/成片拆分之后，没选 BGM 的项目【不会】生成 export.mp4——成片就是
   * master.mp4（省一份 500MB 拷贝）。downloadableFilm 有这条回落，但
   * judgeFilm 一度只查 export.mp4，于是这类项目 filmInfo 永远报「合成中」、
   * 每次轮询还重排一条，UI 卡死、队列空转。
   *
   * 这个雷被所有老项目遗留的 export.mp4 挡着，直到第一个全新的无-BGM
   * 项目（豪门Textest）才引爆。这条测试守住修复：无 export.mp4、只有母带，
   * filmInfo 要报 ready，且【不能重排】。
   */
  it('【只有母带、没有 export.mp4 → ready 且不重排】', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('无BGM成片')
    const dir = assetDir(USER, LIST, id)
    const r = resolveFilm(deps, USER, id)
    if (!r.ok) throw new Error('前置不成立：' + r.error)

    // 造出 buildFilm 在无-BGM 时留下的盘面：母带 + 两个 done 戳，没有 export.mp4
    await writeFile(join(dir, FILM_MASTER_FILE), 'master-bytes')
    await writeStamp(dir, MASTER_STAMP_FILE, { fingerprint: r.film.masterFingerprint, status: 'done', jobId: 'j-m' })
    await writeStamp(dir, FILM_STAMP_FILE, { fingerprint: r.film.fingerprint, status: 'done', jobId: 'j-f' })

    const info = await filmInfo(deps, USER, id)
    expect(info.state).toBe('ready')
    // 【关键】没有触发重排——之前的 bug 就是每次都排一条
    expect(q.enqueued).toEqual([])
  })

  it('【有 BGM 的项目仍认 export.mp4，不被母带回落误判】', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('有BGM成片')
    const dir = assetDir(USER, LIST, id)
    // 给它选一首库里的 BGM，让 bgmPath 非空——此时成片必须是 export.mp4
    const db = openUserDb(USER, LIST)
    // 没有真实库 BGM，直接塞一个 bgm 素材让 resolveFilm 的 bgmPath 非空
    const bgm = join(dir, 'bgm.mp3'); await writeFile(bgm, 'x')
    db.addAsset({ projectId: id, kind: 'bgm', path: bgm, originalName: 'b.mp3', size: 1 })
    db.close()
    const r = resolveFilm(deps, USER, id)
    if (!r.ok) throw new Error('前置不成立：' + r.error)
    // 只有母带、没有 export.mp4 —— 有 BGM 的项目这【不算】ready
    await writeFile(join(dir, FILM_MASTER_FILE), 'm')
    await writeStamp(dir, MASTER_STAMP_FILE, { fingerprint: r.film.masterFingerprint, status: 'done', jobId: 'j-m' })
    await writeStamp(dir, FILM_STAMP_FILE, { fingerprint: r.film.fingerprint, status: 'done', jobId: 'j-f' })

    const info = await filmInfo(deps, USER, id)
    expect(info.state).not.toBe('ready')   // 缺 export.mp4，还没混音，不能算好
  })
})
