import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openLibraryDb, type LibraryDb } from '../../src/library/library-db.js'
import { planProjectBackground, shuffled, rng, seedFrom } from '../../src/library/background.js'

/**
 * 直接往索引库插行，不碰文件系统也不调 ffprobe——
 * 排布是纯计算，测它不需要真视频（真视频的探测已由 scan.test.ts 覆盖）。
 */
function insert (db: LibraryDb, bucket: string, filename: string, durationMs: number): void {
  db.raw.prepare(
    `INSERT INTO library_items (id, bucket, filename, duration_ms, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${bucket}/${filename}`, bucket, filename, durationMs, 1000, '2026-07-19T00:00:00.000Z')
}

async function freshDb (): Promise<{ db: LibraryDb; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sj-bg-'))
  return { db: openLibraryDb(dataDir), dataDir }
}

/**
 * 一套接近真实规模的素材：开头 20 个、常规 20 个 1 秒短片，跑酷 3 个长录屏。
 * 桶里必须有【足够多】的片子，否则"打乱"没有可观察的效果——
 * 3 个元素的桶有 1/6 的概率洗出原顺序，那样的测试会偶发假绿。
 */
function seed (db: LibraryDb): void {
  for (let i = 0; i < 20; i++) insert(db, '1-开头', `开头-${String(i).padStart(2, '0')}.mp4`, 1000)
  for (let i = 0; i < 20; i++) insert(db, '2-常规', `常规-${String(i).padStart(2, '0')}.mp4`, 1000)
  for (let i = 0; i < 3; i++) insert(db, '3-地铁跑酷', `跑酷-${i}.mp4`, 600_000)
  insert(db, '背景音乐', '一笑倾城 现言 甜文.wav', 120_000)
}

describe('planProjectBackground —— 基本契约', () => {
  it('配音未就绪（null）返回空排布，而不是抛错', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    expect(planProjectBackground(db, 'p1', null)).toEqual({ segments: [], totalMs: 0 })
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('配音时长为 0 同样返回空排布', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    expect(planProjectBackground(db, 'p1', 0)).toEqual({ segments: [], totalMs: 0 })
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('片段之和精确等于配音总长，一毫秒不差', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    // 故意取一个会产生舍入余数的怪数：123457×0.27 = 33333.39
    const plan = planProjectBackground(db, 'p1', 123_457)
    expect(plan.totalMs).toBe(123_457)
    expect(plan.segments.reduce((s, x) => s + x.takeMs, 0)).toBe(123_457)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('每段都补上了 filename 和 bucket，前端不用再查一次', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const plan = planProjectBackground(db, 'p1', 10_000)
    expect(plan.segments.length > 0).toBe(true)
    // 契约字段一个不少、一个不多
    const keySets = plan.segments.map((s) => Object.keys(s).sort().join(','))
    expect(new Set(keySets).size).toBe(1)
    expect(keySets[0]).toBe('bucket,filename,itemId,startMs,takeMs')
    // filename 必须非空——空字符串等于没补，前端会显示一片空白
    expect(plan.segments.every((s) => s.filename.length > 0)).toBe(true)
    // bucket / filename 必须与 itemId 指向的那条素材一致，不能张冠李戴
    expect(plan.segments.every((s) => s.itemId === `${s.bucket}/${s.filename}`)).toBe(true)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('三段顺序是 开头 → 常规 → 地铁跑酷', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const plan = planProjectBackground(db, 'p1', 10_000)
    const buckets = plan.segments.map((s) => s.bucket)
    const runs = buckets.filter((b, i) => b !== buckets[i - 1])
    expect(runs).toEqual(['1-开头', '2-常规', '3-地铁跑酷'])
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('背景音乐桶不参与背景视频排布', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const plan = planProjectBackground(db, 'p1', 300_000)
    expect(plan.segments.some((s) => s.bucket === '背景音乐')).toBe(false)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('素材库为空时抛错——这是"没扫过库"，不是"配音没好"，不能混为一谈', async () => {
    const { db, dataDir } = await freshDb()
    expect(() => planProjectBackground(db, 'p1', 10_000)).toThrow(/素材/)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('只有跑酷桶有素材时，缺口顺延过去，总长仍然精确', async () => {
    const { db, dataDir } = await freshDb()
    insert(db, '3-地铁跑酷', '跑酷长录屏.mp4', 600_000)
    const plan = planProjectBackground(db, 'p1', 30_000)
    expect(plan.segments.reduce((s, x) => s + x.takeMs, 0)).toBe(30_000)
    expect(plan.segments.map((s) => s.bucket)).toEqual(['3-地铁跑酷'])
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })
})

describe('planProjectBackground —— 按项目 id 做种子的随机挑选', () => {
  it('同一项目 id 连算 100 次，排布完全一致', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const first = planProjectBackground(db, 'proj-abc', 47_123)
    // 预览条看到的排布必须和导出时用的一模一样，否则用户每刷新一次就变一次
    for (let i = 0; i < 100; i++) {
      expect(planProjectBackground(db, 'proj-abc', 47_123)).toEqual(first)
    }
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('不同项目 id 的排布不同——随机是真的在起作用，不是摆设', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const ids = ['proj-a', 'proj-b', 'proj-c', 'proj-d', 'proj-e']
    const fingerprints = ids.map((id) =>
      planProjectBackground(db, id, 47_123).segments.map((s) => s.itemId).join('|'))
    // 五个项目应当得到五种不同的组合。若 seed 没接上，这里会全都一样。
    expect(new Set(fingerprints).size).toBe(5)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('开头段选到的片子确实随项目而变，而不只是顺序变了', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    // 开头段目标 = 10000×0.27 = 2700ms，1 秒一片 → 只取得下 3 片，
    // 20 个候选里挑 3 个，不同项目挑中的集合应当不同
    const pick = (id: string): string[] =>
      planProjectBackground(db, id, 10_000).segments
        .filter((s) => s.bucket === '1-开头').map((s) => s.itemId).sort()
    const a = pick('proj-a')
    const b = pick('proj-b')
    expect(a.length).toBe(3)
    expect(b.length).toBe(3)
    expect(a).not.toEqual(b)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('⚠️ 已知取舍：素材库新增文件后，老项目的排布【会变】', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const before = planProjectBackground(db, 'proj-abc', 47_123)

    insert(db, '1-开头', '开头-新来的.mp4', 1000)
    const after = planProjectBackground(db, 'proj-abc', 47_123)

    /*
     * 种子只由项目 id 决定，但被打乱的【数组内容】变了，Fisher-Yates
     * 的结果自然跟着变。所以扫进新素材会让已有项目的背景排布改变。
     *
     * 这不是 bug，是这个方案的已知代价：排布不落库、每次现算，
     * 换来的是"项目只存引用、不复制 4.7GB 素材"。
     *
     * 【什么时候会咬人】：用户看完预览条就去扫库，再点导出——
     * 成片的背景会和他刚才看到的不一样。真要根治，得在项目上落一列
     * 存排布快照，那是另一个任务的事。这里如实记录，不假装它不会变。
     */
    expect(after).not.toEqual(before)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('配音时长变了，排布跟着变——背景长度由配音决定', async () => {
    const { db, dataDir } = await freshDb()
    seed(db)
    const a = planProjectBackground(db, 'proj-abc', 47_123)
    const b = planProjectBackground(db, 'proj-abc', 90_000)
    expect(b.totalMs).toBe(90_000)
    expect(b.segments).not.toEqual(a.segments)
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })
})

describe('shuffled —— Fisher-Yates 正确性', () => {
  it('不丢素材、不重复：洗完还是同一个集合', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`)
    const out = shuffled(items, rng(seedFrom('proj-abc')))
    expect(out.length).toBe(items.length)
    expect([...out].sort()).toEqual([...items].sort())
    expect(new Set(out).size).toBe(items.length)
  })

  it('不改入参——原数组必须原封不动', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
    const snapshot = [...items]
    shuffled(items, rng(seedFrom('proj-abc')))
    expect(items).toEqual(snapshot)
  })

  it('确实打乱了顺序（50 个元素原样返回的概率可以忽略）', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`)
    expect(shuffled(items, rng(seedFrom('proj-abc')))).not.toEqual(items)
  })

  it('空数组和单元素数组不炸', () => {
    expect(shuffled([], rng(1))).toEqual([])
    expect(shuffled(['only'], rng(1))).toEqual(['only'])
  })

  it('同一种子洗出同样的结果，不同种子洗出不同结果', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`)
    expect(shuffled(items, rng(seedFrom('x')))).toEqual(shuffled(items, rng(seedFrom('x'))))
    expect(shuffled(items, rng(seedFrom('x')))).not.toEqual(shuffled(items, rng(seedFrom('y'))))
  })

  it('洗牌是均匀的：每个元素都能到达每个位置', () => {
    // Fisher-Yates 写错成 `j = floor(rand()*i)` 之类的偏置版本时，
    // 某些位置永远轮不到某些元素——用 200 次采样把这种偏置照出来
    const items = ['a', 'b', 'c', 'd']
    const seen = new Map<string, Set<number>>(items.map((x) => [x, new Set<number>()]))
    for (let i = 0; i < 200; i++) {
      shuffled(items, rng(seedFrom(`seed-${i}`))).forEach((x, pos) => seen.get(x)?.add(pos))
    }
    expect(items.map((x) => seen.get(x)?.size)).toEqual([4, 4, 4, 4])
  })
})

describe('seedFrom / rng', () => {
  it('seedFrom 是确定的 32 位无符号整数', () => {
    expect(seedFrom('proj-abc')).toBe(seedFrom('proj-abc'))
    const s = seedFrom('proj-abc')
    expect(Number.isInteger(s) && s >= 0 && s <= 0xFFFFFFFF).toBe(true)
  })

  it('seedFrom 对不同输入给出不同种子（含只差一个字符的）', () => {
    const ids = ['proj-a', 'proj-b', 'a', 'b', '', '陈梓昂', 'proj-a ']
    expect(new Set(ids.map(seedFrom)).size).toBe(ids.length)
  })

  it('rng 产出 [0,1) 区间的数，且同种子可复现', () => {
    const a = Array.from({ length: 100 }, rng(12345))
    const b = Array.from({ length: 100 }, rng(12345))
    expect(a).toEqual(b)
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true)
    // 不是常数序列——退化成常数的话洗牌就废了
    expect(new Set(a).size > 90).toBe(true)
  })
})
