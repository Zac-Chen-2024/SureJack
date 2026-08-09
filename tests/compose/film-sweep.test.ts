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
    /*
     * ⚠️【夹具必须造【合成端真正产出的东西】】。
     *
     * 这条守卫本该抓住一次线上回归，却没抓住：那时它手工造一个 export.mp4，
     * 而代码也在找 export.mp4——两边一致，测试当然绿。它测不到的是
     * 【合成端已经不再产出那个文件了】，于是判据永远不成立 →
     * 每次轮询都重排一条 → 后台无限空转，用户看到进度条永远 0%。
     *
     * 照着旧世界造数据的夹具，永远发现不了"产物定义变了"。
     * 现在造的是母带（画面）——那才是合成端唯一常驻的产物。
     */
    const rr = resolveFilm(deps, USER, id)
    if (!rr.ok) throw new Error('前置不成立：' + rr.error)
    await writeFile(join(dir, FILM_MASTER_FILE), 'pretend-master')
    await writeStamp(dir, MASTER_STAMP_FILE, {
      fingerprint: rr.film.masterFingerprint, status: 'done', jobId: 'old-job',
    })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual([])
    expect(q.enqueued).toEqual([])
    expect(r.skipped).toBe(1)
  })

  /*
   * 用户在「正在生成」页点了中断，取消路由会写下 status:'cancelled'。
   * 若不认这个状态，盘上没成片 → 判定 missing → 立刻又排一条，
   * 用户会看到"我明明点了取消，它自己又开始合了"。
   */
  it('【用户取消的不自动重排】否则中断按钮等于没点', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('被用户掐掉的')
    const dir = assetDir(USER, LIST, id)
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint: fingerprintOf(deps, id), status: 'cancelled', jobId: 'j-cancel',
    })

    const r = await sweepFilms(deps, LIST)

    expect(r.enqueued).toEqual([])
    expect(q.enqueued).toEqual([])
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

describe('就绪 = 母带在，不是 export.mp4 在', () => {
  /*
   * ⚠️ 这条断言【翻过两次面】，每次都是对的，只是产物的定义变了：
   *
   *   ① 最早：没选 BGM 的项目不生成 export.mp4，成片就是母带 → 认回落。
   *   ② 加封面之后：成片一定比母带多两帧，两者不是同一个文件 → 不认回落。
   *   ③ 现在：成片【在下载那一刻才现混】，盘上根本不存在 export.mp4
   *      → 判据只能认母带。
   *
   * 第 ③ 次翻面的代价是一次线上回归：判据还在等一个再也不会出现的文件，
   * 于是「能播放、但下载灰着、列表永远 0%、后台无限重排」四个症状一起出现。
   *
   * 【教训】：改了产物的定义，就必须同时改判定它的那一行——以及【夹具】。
   */
  it('【只有母带 → 就绪】成片是下载时才现混的，盘上不该等 export.mp4', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('无BGM成片')
    const dir = assetDir(USER, LIST, id)
    const r = resolveFilm(deps, USER, id)
    if (!r.ok) throw new Error('前置不成立：' + r.error)

    await writeFile(join(dir, FILM_MASTER_FILE), 'master-bytes')
    await writeStamp(dir, MASTER_STAMP_FILE, { fingerprint: r.film.masterFingerprint, status: 'done', jobId: 'j-m' })

    const info = await filmInfo(deps, USER, id)
    expect(info.state).toBe('ready')
    // ⚠️ 已经就绪就不该再排任何活——这正是"无限重排"那次回归的直接症状
    expect(q.enqueued).toEqual([])
  })

  it('【选了 BGM 也一样就绪】音乐是下载时才混进去的，不影响盘上的画面', async () => {
    const deps = q.deps(dataDir)
    const id = await makeReadyProject('有BGM成片')
    const dir = assetDir(USER, LIST, id)
    const db = openUserDb(USER, LIST)
    const bgm = join(dir, 'bgm.mp3'); await writeFile(bgm, 'x')
    db.addAsset({ projectId: id, kind: 'bgm', path: bgm, originalName: 'b.mp3', size: 1 })
    db.close()
    const r = resolveFilm(deps, USER, id)
    if (!r.ok) throw new Error('前置不成立：' + r.error)
    await writeFile(join(dir, FILM_MASTER_FILE), 'm')
    await writeStamp(dir, MASTER_STAMP_FILE, { fingerprint: r.film.masterFingerprint, status: 'done', jobId: 'j-m' })

    const info = await filmInfo(deps, USER, id)
    /*
     * 换 BGM / 调音量都【不该】把"就绪"打翻：它们在下载那一刻才生效，
     * 盘上的画面一帧都没变。以前它们进成片指纹、会触发重合，那是旧架构。
     */
    expect(info.state).toBe('ready')
  })
})
