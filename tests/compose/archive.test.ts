import { describe, it, expect, afterEach } from 'vitest'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { userDbDir } from '../../src/auth/whitelist.js'
import { assetDir } from '../../src/assets/storage.js'
import { archiveProject, sweepArchive, sweepOrphanAssets, ARCHIVE_AFTER_MS } from '../../src/compose/archive.js'

/*
 * 归档 = 把久未使用的项目压缩成"索引 + 参数 + 配音"。
 * 实测一条 13 分钟的片子：bg-track 632MB + master 727MB 是【可以再算出来的】，
 * voice.mp3 只有 9MB 却【不可重来】（重配音会拿到不同的词级时间戳，字幕全错位）。
 * 所以删前两个、留最后一个：1.3GB → 9MB，而且一个字节的用户数据都没丢。
 */
const USER = '__测试归档__'
const LIST = [USER]

afterEach(async () => { await rm(userDbDir(USER, LIST), { recursive: true, force: true }) })

async function seed (name: string, opts: { downloaded?: string; touched?: string } = {}): Promise<string> {
  const db = openUserDb(USER, LIST)
  const p = db.createProject(name)
  db.updateProject(p.id, {
    downloadedAt: opts.downloaded ?? '',
    touchedAt: opts.touched ?? new Date().toISOString(),
  })
  db.close()
  const dir = assetDir(USER, LIST, p.id)
  await mkdir(join(dir, 'preview'), { recursive: true })
  await writeFile(join(dir, 'master.mp4'), 'x'.repeat(1000))
  await writeFile(join(dir, 'bg-track.mp4'), 'x'.repeat(2000))
  await writeFile(join(dir, 'preview', 'seg-0000.ts'), 'x'.repeat(500))
  await writeFile(join(dir, 'voice.mp3'), 'keep-me')
  return p.id
}

describe('归档：删可重算的，留不可重来的', () => {
  it('删掉母带/背景轨/预览，【配音一定留着】', async () => {
    const id = await seed('要收起来的')
    const dir = assetDir(USER, LIST, id)
    const freed = await archiveProject(USER, LIST, id)

    expect(existsSync(join(dir, 'master.mp4'))).toBe(false)
    expect(existsSync(join(dir, 'bg-track.mp4'))).toBe(false)
    expect(existsSync(join(dir, 'preview', 'seg-0000.ts'))).toBe(false)
    /*
     * ⚠️ 这条是整个归档最要紧的断言。配音删了就再也回不来了：
     * 重新合成会拿到【不同的词级时间戳】，字幕整体错位，而且要再烧一次
     * Azure 配额。9MB 换"逐帧一致的复原"，没有任何理由省。
     */
    expect(existsSync(join(dir, 'voice.mp3'))).toBe(true)
    expect(freed).toBeGreaterThan(3000)

    const db = openUserDb(USER, LIST)
    expect(db.getProject(id)?.archivedAt).not.toBe('')
    // 库里的东西一个字段都不能动——那才是复原的依据
    expect(db.getProject(id)?.name).toBe('要收起来的')
    db.close()
  })
})

describe('归档扫描：只收该收的', () => {
  const long = new Date(Date.now() - ARCHIVE_AFTER_MS - 60_000).toISOString()

  it('下载过 + 两小时没动 → 收', async () => {
    await seed('该收的', { downloaded: long, touched: long })
    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.name)).toEqual(['该收的'])
  })

  /*
   * 没下载过说明还在打磨。把用户正在改的东西收走，他下次进来要等十几分钟
   * 才能接着看——那是帮倒忙。
   */
  it('【没下载过的不收】哪怕放了很久', async () => {
    await seed('还在改的', { touched: long })
    expect(await sweepArchive(LIST)).toEqual([])
  })

  it('刚动过的不收', async () => {
    await seed('刚看过的', { downloaded: long, touched: new Date().toISOString() })
    expect(await sweepArchive(LIST)).toEqual([])
  })

  it('已经收过的不重复收', async () => {
    const id = await seed('收过了', { downloaded: long, touched: long })
    await archiveProject(USER, LIST, id)
    expect(await sweepArchive(LIST)).toEqual([])
  })
})

describe('孤儿素材目录', () => {
  /*
   * 项目删了、文件还躺在盘上。线上真有一个这样的目录白占 1.34GB，
   * 而没有任何东西会来认领它。
   */
  it('项目已经不在了 → 目录清掉', async () => {
    const id = await seed('待删的')
    const dir = assetDir(USER, LIST, id)
    const db = openUserDb(USER, LIST)
    db.deleteProject(id)          // 只删库行，模拟历史上"删了行没删文件"
    db.close()
    expect(existsSync(dir)).toBe(true)

    const freed = await sweepOrphanAssets(LIST)
    expect(existsSync(dir)).toBe(false)
    expect(freed).toBeGreaterThan(0)
  })

  it('活着的项目一个都不能碰', async () => {
    const id = await seed('活的')
    await sweepOrphanAssets(LIST)
    expect(existsSync(join(assetDir(USER, LIST, id), 'voice.mp3'))).toBe(true)
  })
})
