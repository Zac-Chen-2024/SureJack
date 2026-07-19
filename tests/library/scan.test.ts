import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { scanBucket, listBucket } from '../../src/library/scan.js'
import { bucketDir } from '../../src/library/paths.js'

const exec = promisify(execFile)

/**
 * 用 ffmpeg 现生成一个真实的小视频。
 *
 * 【不依赖用户的 Material/Video.zip】——那是 8.4GB 且尚未解压，
 * 测试不该依赖它。testsrc 生成的 64x64 片子几十 KB，ffprobe 能读出真实时长。
 */
async function makeVideo (path: string, seconds: number): Promise<void> {
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=64x64`,
    '-pix_fmt', 'yuv420p', path,
  ])
}

/** 每个用例一套全新的临时素材库，避免用例之间互相污染 */
async function setup (): Promise<{ dataDir: string; db: LibraryDb; dir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
  const dir = bucketDir(dataDir, '1-开头')
  await mkdir(dir, { recursive: true })
  const db = openLibraryDb(dataDir)
  return { dataDir, db, dir }
}

describe('scanBucket', () => {
  it('扫描把桶里的视频写进索引', async () => {
    const { dataDir, db, dir } = await setup()
    await makeVideo(join(dir, 'a.mp4'), 1)
    await makeVideo(join(dir, 'b.mp4'), 1)

    const r = await scanBucket(db, dataDir, '1-开头')
    expect(r.added).toBe(2)
    expect(r.total).toBe(2)

    const items = listBucket(db, '1-开头')
    expect(items.length).toBe(2)
    // noUncheckedIndexedAccess：整体比对，不用 items[0].x
    expect(items.map((i) => i.filename)).toEqual(['a.mp4', 'b.mp4'])
    expect(items.map((i) => i.bucket)).toEqual(['1-开头', '1-开头'])
    // 探测到的时长应接近 1 秒，而不是 0 或 null
    expect(items.map((i) => i.durationMs > 500 && i.durationMs < 2000)).toEqual([true, true])
    expect(items.map((i) => i.sizeBytes > 0)).toEqual([true, true])
    expect(items.map((i) => i.id.length > 0)).toEqual([true, true])

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('重复扫描幂等，不产生重复行', async () => {
    const { dataDir, db, dir } = await setup()
    await makeVideo(join(dir, 'a.mp4'), 1)
    await makeVideo(join(dir, 'b.mp4'), 1)

    await scanBucket(db, dataDir, '1-开头')
    const idsFirst = listBucket(db, '1-开头').map((i) => i.id)

    const r2 = await scanBucket(db, dataDir, '1-开头')
    expect(r2.added).toBe(0)
    expect(r2.total).toBe(2)
    expect(listBucket(db, '1-开头').length).toBe(2)
    // id 必须稳定：重扫不能给同一个文件换一个新 id（项目只存引用，换 id 会把引用打断）
    expect(listBucket(db, '1-开头').map((i) => i.id)).toEqual(idsFirst)

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('损坏文件被跳过，不中断整轮扫描', async () => {
    const { dataDir, db, dir } = await setup()
    await makeVideo(join(dir, 'a.mp4'), 1)
    await makeVideo(join(dir, 'b.mp4'), 1)
    await writeFile(join(dir, 'broken.mp4'), 'not a video')

    const r = await scanBucket(db, dataDir, '1-开头')
    // 坏文件不应入库，但两个好文件必须照常入库
    expect(r.added).toBe(2)
    expect(listBucket(db, '1-开头').map((i) => i.filename)).toEqual(['a.mp4', 'b.mp4'])

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("文件名含单引号也能正常入库", async () => {
    const { dataDir, db, dir } = await setup()
    // 用户素材里真实存在：剪素材n'n.mp4
    await makeVideo(join(dir, "剪素材n'n.mp4"), 1)
    await scanBucket(db, dataDir, '1-开头')
    expect(listBucket(db, '1-开头').some((i) => i.filename.includes("'"))).toBe(true)

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /*
   * 以下为计划之外的独立验证。
   */

  it('文件名批量损坏（缺右括号）也只当作不透明字符串，照常入库', async () => {
    const { dataDir, db, dir } = await setup()
    // 用户素材里真实存在这类名字，不要试图从文件名解析任何语义
    const names = ['6月1日(8.mp4', '剪素材(1.mp4']
    for (const n of names) await makeVideo(join(dir, n), 1)

    const r = await scanBucket(db, dataDir, '1-开头')
    expect(r.added).toBe(2)
    expect(listBucket(db, '1-开头').map((i) => i.filename).sort()).toEqual([...names].sort())

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('非视频扩展名被跳过', async () => {
    const { dataDir, db, dir } = await setup()
    await makeVideo(join(dir, 'a.mp4'), 1)
    await writeFile(join(dir, 'readme.txt'), 'hello')
    await writeFile(join(dir, 'cover.jpg'), 'x')
    await writeFile(join(dir, '.DS_Store'), 'x')

    const r = await scanBucket(db, dataDir, '1-开头')
    expect(r.added).toBe(1)
    expect(listBucket(db, '1-开头').map((i) => i.filename)).toEqual(['a.mp4'])

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('背景音乐桶收音频扩展名，不收视频', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
    const dir = bucketDir(dataDir, '背景音乐')
    await mkdir(dir, { recursive: true })
    const db = openLibraryDb(dataDir)

    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=d=1', join(dir, 'song.mp3')])
    await makeVideo(join(dir, 'notmusic.mp4'), 1)

    const r = await scanBucket(db, dataDir, '背景音乐')
    expect(r.added).toBe(1)
    expect(listBucket(db, '背景音乐').map((i) => i.filename)).toEqual(['song.mp3'])

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('未知桶名被拒绝——扫描也走同一道白名单闸', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
    const db = openLibraryDb(dataDir)
    await expect(scanBucket(db, dataDir, '../../../etc')).rejects.toThrow(/桶/)
    await expect(scanBucket(db, dataDir, '随便一个桶')).rejects.toThrow(/桶/)
    expect(() => listBucket(db, '../../../etc')).toThrow(/桶/)

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('桶目录不存在时不崩溃，返回空结果', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
    const db = openLibraryDb(dataDir)
    const r = await scanBucket(db, dataDir, '3-地铁跑酷')
    expect(r.added).toBe(0)
    expect(r.total).toBe(0)
    expect(listBucket(db, '3-地铁跑酷')).toEqual([])

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('各桶索引互不串台', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
    const db = openLibraryDb(dataDir)
    for (const b of ['1-开头', '2-常规'] as const) {
      const dir = bucketDir(dataDir, b)
      await mkdir(dir, { recursive: true })
      await makeVideo(join(dir, 'same-name.mp4'), 1)
    }
    await scanBucket(db, dataDir, '1-开头')
    await scanBucket(db, dataDir, '2-常规')

    // 同名文件在两个桶里各算一条，UNIQUE 是 (bucket, filename) 而非 filename
    expect(listBucket(db, '1-开头').length).toBe(1)
    expect(listBucket(db, '2-常规').length).toBe(1)
    const ids = [...listBucket(db, '1-开头'), ...listBucket(db, '2-常规')].map((i) => i.id)
    expect(new Set(ids).size).toBe(2)

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('索引库落在 data/library/library.db，不进任何用户目录', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sj-library-'))
    const db = openLibraryDb(dataDir)
    expect(db.path).toBe(join(dataDir, 'library', 'library.db'))
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('新增文件后重扫只增量补入，已有行不动', async () => {
    const { dataDir, db, dir } = await setup()
    await makeVideo(join(dir, 'a.mp4'), 1)
    await scanBucket(db, dataDir, '1-开头')
    const firstIds = listBucket(db, '1-开头').map((i) => i.id)

    await makeVideo(join(dir, 'b.mp4'), 1)
    const r = await scanBucket(db, dataDir, '1-开头')
    expect(r.added).toBe(1)
    expect(r.total).toBe(2)
    // 原有那条的 id 不变
    expect(listBucket(db, '1-开头').map((i) => i.id).slice(0, 1)).toEqual(firstIds)

    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })
})
