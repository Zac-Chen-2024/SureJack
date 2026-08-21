import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { assetDir } from '../../src/assets/storage.js'
import { reclaimable, undownloaded, blockedMessage, gb } from '../../src/compose/disk-guard.js'
import { FILM_MASTER_FILE } from '../../src/compose/film.js'

/**
 * 磁盘两步回收。**守的是用户定的那条原则**：
 *
 *   磁盘压力只用「可重算的东西」化解，永远不动用户还没拿到手的成品。
 *
 * 第一步只收「已经下载走、只是还没到两小时阈值」的项目——他的成品早就
 * 拿到手了，盘上剩的（母带 + 预览）全是可重算的。
 * 第二步腾不出来时不删任何东西，只告诉用户去下载。
 */

const LIST = ['__磁盘甲__']
const made: string[] = []

afterEach(async () => {
  for (const u of made.splice(0)) {
    await rm(join('data', u), { recursive: true, force: true }).catch(() => {})
  }
})

/** 造一条项目，带一份指定大小的母带 */
async function makeProject (
  name: string, opts: { downloaded?: boolean, archived?: boolean, masterMB?: number } = {},
): Promise<string> {
  made.push(LIST[0]!)
  const db = openUserDb(LIST[0]!, LIST)
  const p = db.createProject(name)
  db.updateProject(p.id, {
    downloadedAt: opts.downloaded === true ? new Date().toISOString() : '',
    archivedAt: opts.archived === true ? new Date().toISOString() : '',
  })
  db.close()
  const dir = assetDir(LIST[0]!, LIST, p.id)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  /*
   * ⚠️【归档 = 母带被删掉】，所以造"已归档"的夹具时不能留着母带。
   *
   * 这里【曾经】两个都写：标了 archivedAt，还照样写一份 master.mp4——
   * 那正是线上那个非法态（标记过期）。当时判据是"光看 archivedAt"，
   * 所以假数据也能过；改成 isArchived（标记在【而且】母带确实不在）之后，
   * 这份夹具就露馅了：一条母带还在的项目本来就该是可回收的。
   *
   * 用例的意图没变（真收着的不重复收），变的是夹具得说实话。
   */
  if (opts.archived !== true) {
    await writeFile(join(dir, FILM_MASTER_FILE), Buffer.alloc((opts.masterMB ?? 1) * 1024 * 1024))
  }
  return p.id
}

describe('第一步：只收「已下载但还没归档」的', () => {
  it('已下载未归档的能收', async () => {
    const id = await makeProject('已下载的', { downloaded: true, masterMB: 3 })
    const list = reclaimable(LIST)
    expect(list.map((r) => r.projectId)).toContain(id)
    expect(list.find((r) => r.projectId === id)!.bytes).toBeGreaterThan(2 * 1024 * 1024)
  })

  /*
   * ⚠️ 这一条是核心：**没下载走的绝不能碰**。它的母带一没，用户就得
   * 等十几分钟重烧——而那份片子他还没拿到手。
   */
  it('【没下载走的绝不能收】', async () => {
    const id = await makeProject('还没下载的', { downloaded: false, masterMB: 3 })
    expect(reclaimable(LIST).map((r) => r.projectId)).not.toContain(id)
  })

  it('真的收着的（母带确实不在）不重复收', async () => {
    const id = await makeProject('已归档的', { downloaded: true, archived: true })
    expect(reclaimable(LIST).map((r) => r.projectId)).not.toContain(id)
  })

  /*
   * ⚠️ 线上真发生过：状态接口把归档的片子又重烧了出来，而 archivedAt 没人清。
   * 光看标记的话，这 6.9 GB 就永远没人来收——**磁盘告急时也不回收**。
   * 读事实就能自愈：母带回来了，它就重新算进可回收的。
   */
  it('标了归档但母带又回来了 → 重新算进可回收的', async () => {
    const id = await makeProject('母带又长出来了', { downloaded: true, masterMB: 3 })
    const db = openUserDb(LIST[0]!, LIST)
    db.updateProject(id, { archivedAt: new Date().toISOString() })   // 标记过期，母带还在
    db.close()
    expect(reclaimable(LIST).map((r) => r.projectId)).toContain(id)
  })
})

describe('第二步：腾不出来时，告诉用户去下载哪一条', () => {
  it('列出的是「合成好了但没下载」的，占得多的排前面', async () => {
    const small = await makeProject('小的', { downloaded: false, masterMB: 1 })
    const big = await makeProject('大的', { downloaded: false, masterMB: 5 })
    const list = undownloaded(LIST)
    expect(list[0]!.projectId).toBe(big)
    expect(list.map((u) => u.projectId)).toContain(small)
  })

  it('已经下载走的不该出现在建议里——它腾不出用户在意的空间', async () => {
    const id = await makeProject('下过的', { downloaded: true, masterMB: 5 })
    expect(undownloaded(LIST).map((u) => u.projectId)).not.toContain(id)
  })
})

describe('给用户看的话必须能照着做', () => {
  it('点名要下载哪一条、能腾多少', () => {
    const msg = blockedMessage({
      ok: false, freed: 0, free: 1e9, archived: [],
      suggest: [{ projectId: 'x', name: '周周隐婚', bytes: 5e8 }],
    })
    expect(msg).toContain('周周隐婚')
    expect(msg).toContain('自动继续合成')
  })

  it('实在没得回收时说清楚，而不是让用户干等', () => {
    const msg = blockedMessage({ ok: false, freed: 0, free: 1e9, archived: [], suggest: [] })
    expect(msg).toContain('请联系开发人员')
  })

  it('gb 说人话', () => {
    expect(gb(1.5 * 1024 * 1024 * 1024)).toBe('1.5')
  })
})
