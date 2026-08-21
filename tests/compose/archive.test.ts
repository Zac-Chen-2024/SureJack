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

async function seed (
  name: string,
  opts: { downloaded?: string; touched?: string; parent?: string } = {},
): Promise<string> {
  const db = openUserDb(USER, LIST)
  const p = db.createProject(name)
  db.updateProject(p.id, {
    ...(opts.parent === undefined ? {} : { parentProjectId: opts.parent, episodeIndex: 2 }),
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

describe('续集跟着主片一起收', () => {
  const long = new Date(Date.now() - ARCHIVE_AFTER_MS - 60_000).toISOString()

  /*
   * 用户定的：续集无条件随主片归档。续集通常一两分钟、复原很快，而
   * "主片收了、续集还摊着"会让同一部戏的两半在盘上长期不同步。
   *
   * ⚠️ 这一条【盖掉了「没下载的文件就一直留着」】。那条规矩是为正片定的
   * ——正片没下载 = 用户还在打磨，收走是帮倒忙。续集跟着主片走。
   */
  it('主片被收 → 续集哪怕没下载过也跟着收', async () => {
    const main = await seed('主片', { downloaded: long, touched: long })
    await seed('续集', { parent: main })          // 没下载、刚刚才动过

    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.name).sort()).toEqual(['主片', '续集'])

    const db = openUserDb(USER, LIST)
    for (const p of db.listProjects()) expect(p.archivedAt).not.toBe('')
    db.close()
  })

  /* 反过来不成立：续集自己到点了，不该把还在用的主片一起收走 */
  it('续集被收，主片不跟着走', async () => {
    const main = await seed('还在改的主片')
    await seed('到点的续集', { parent: main, downloaded: long, touched: long })

    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.name)).toEqual(['到点的续集'])

    const db = openUserDb(USER, LIST)
    expect(db.listProjects().find((p) => p.name === '还在改的主片')?.archivedAt).toBe('')
    db.close()
  })

  /*
   * ⚠️ rows 是开工前的快照，而收主片时已经把续集一起收了。不去重的话，
   * 轮到续集自己那一行时快照里它还是"没归档"，于是又收一遍——第二遍没
   * 东西可删，但会把 archivedAt 覆盖成新时间，归档时长从头算起。
   */
  it('同一条不会被收两次（续集自己也到点时）', async () => {
    const main = await seed('主片', { downloaded: long, touched: long })
    await seed('续集', { parent: main, downloaded: long, touched: long })

    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.projectId).length).toBe(new Set(r.map((x) => x.projectId)).size)
    expect(r.length).toBe(2)
  })

  it('已经收着的续集不会再被翻出来收一遍', async () => {
    const main = await seed('主片', { downloaded: long, touched: long })
    const kid = await seed('早就收了的续集', { parent: main })
    await archiveProject(USER, LIST, kid)
    const at = openUserDb(USER, LIST).getProject(kid)!.archivedAt

    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.name)).toEqual(['主片'])
    const db = openUserDb(USER, LIST)
    expect(db.getProject(kid)?.archivedAt).toBe(at)   // 时间没被覆盖
    db.close()
  })
})

describe('读事实，不读标记', () => {
  const long = new Date(Date.now() - ARCHIVE_AFTER_MS - 60_000).toISOString()

  /*
   * ⚠️ 线上真发生过，而且是系统性的：状态接口在 missing 那一档会
   * "该有却没有 → 现在排一条"，而【归档本来就是把母带删掉】——
   * 在它眼里每条归档项目都是"该有却没有"。她一打开 App，列表页给每条
   * 项目轮询一次 /film，后台就默默把收起来的片子一条条重烧。
   *
   * 实测 18 条【全部】是归档后 1~3 小时又长出来的，而 archivedAt 没人清。
   * 于是 sweepArchive 和 disk-guard 都当它们"已经收起来了"而跳过——
   * 7.8 GB 永久占在盘上，磁盘一路到 92%，归档等于完全白做。
   *
   * 判据必须是 isArchived（标记在【而且】母带确实不在），
   * 这样母带一旦又回来，下一轮扫描就能重新收它，脏状态自愈。
   */
  it('标了归档但母带又回来了 → 照样能被收走', async () => {
    const id = await seed('母带又长出来了', { downloaded: long, touched: long })
    // 先正常归档一次（母带被删）
    await archiveProject(USER, LIST, id)
    // 再模拟"状态接口把它重烧了出来"：母带回来，archivedAt 还留着
    await writeFile(join(assetDir(USER, LIST, id), 'master.mp4'), 'x'.repeat(1000))

    const r = await sweepArchive(LIST)
    expect(r.map((x) => x.name)).toEqual(['母带又长出来了'])
    expect(existsSync(join(assetDir(USER, LIST, id), 'master.mp4'))).toBe(false)
  })

  /* 真·归档（标记在、母带确实不在）还是要跳过，别空转 */
  it('真的收着的不会被反复扫', async () => {
    const id = await seed('真收着', { downloaded: long, touched: long })
    await archiveProject(USER, LIST, id)
    const at = openUserDb(USER, LIST).getProject(id)!.archivedAt

    expect(await sweepArchive(LIST)).toEqual([])
    const db = openUserDb(USER, LIST)
    expect(db.getProject(id)?.archivedAt).toBe(at)   // 时间没被覆盖
    db.close()
  })
})
