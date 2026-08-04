import { describe, it, expect, afterEach } from 'vitest'
import { rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { assetDir } from '../../src/assets/storage.js'
import { finishedSince } from '../../src/queue/notify.js'

/*
 * 通知靠【成片的落盘时间】判断"刚做完"，不另存一份完成记录。
 * 另存一份意味着两处状态要保持一致，而它们迟早不一致（删了成片、
 * 手工重烧、进程被杀）——到时候通知说做完了、点进去没有片子。
 */
/*
 * ⚠️【data 根目录是模块加载时按 __dirname 算死的，换不了】。
 * 试过用 SUREJACK_DATA_DIR 指到临时目录——那个环境变量根本不存在，
 * 于是测试【在真实的 data 目录里】建了用户和项目，跑完还留在那儿。
 * 所以这里老老实实用真实路径，用一个不会和真人撞名的用户，跑完删干净。
 */
const USER = '__测试通知__'
const LIST = [USER]

afterEach(async () => {
  const db = openUserDb(USER, LIST)
  const ids = db.listProjects().map((p) => p.id)
  db.close()
  for (const id of ids) await rm(assetDir(USER, LIST, id), { recursive: true, force: true })
  await rm(join(assetDir(USER, LIST, 'x').replace(/\/assets\/x$/, '')), { recursive: true, force: true })
})

async function seed (name: string, filmAtMs: number | null): Promise<string> {
  const db = openUserDb(USER, LIST)
  const p = db.createProject(name)
  db.close()
  if (filmAtMs !== null) {
    const d = assetDir(USER, LIST, p.id)
    await mkdir(d, { recursive: true })
    const f = join(d, 'export.mp4')
    await writeFile(f, 'x')
    await utimes(f, filmAtMs / 1000, filmAtMs / 1000)
  }
  return p.id
}

describe('哪些片子刚做完', () => {
  it('成片比 since 新 → 报出来', async () => {
    await seed('刚烧完的', 5000)
    const r = await finishedSince(USER, LIST, 1000)
    expect(r).toHaveLength(1)
    expect(r[0]?.name).toBe('刚烧完的')
    expect(r[0]?.finishedAt).toBe(5000)
  })

  it('成片比 since 旧 → 不报（否则每次轮询都重复通知同一条）', async () => {
    await seed('早就烧完的', 1000)
    expect(await finishedSince(USER, LIST, 5000)).toEqual([])
  })

  it('没有成片 → 不报（还没烧完，或者被删了）', async () => {
    await seed('还没烧的', null)
    expect(await finishedSince(USER, LIST, 0)).toEqual([])
  })

  it('多条按完成先后排', async () => {
    await seed('先完成的', 2000)
    await seed('后完成的', 8000)
    const r = await finishedSince(USER, LIST, 0)
    expect(r.map((x) => x.name)).toEqual(['先完成的', '后完成的'])
  })
})
