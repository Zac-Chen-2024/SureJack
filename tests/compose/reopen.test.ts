import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planHeadSwap } from '../../src/compose/reopen.js'
import { FILM_MASTER_FILE, MASTER_STAMP_FILE, type FilmPlan } from '../../src/compose/film.js'
import type { Stamp } from '../../src/compose/stamp.js'

/*
 * 【只换开头】的准入判断。
 *
 * 这一组全是在防同一件事:**拿一条不该复用的后半段去拼**。
 * 判错的代价不对称——
 * · 该换却判成不能 → 整条重烧,慢十几分钟,没别的坏处
 * · 不该换却判成能 → 发给用户一条前后对不上、或者前几帧是花的片子,
 *   而时长、进度条、ffprobe 全都正常,只有真播才看得出来
 * 所以每一条不确定都必须倒向 null(整条重烧)。
 */

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'reopen-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const BOUNDARY = 30_000
const TAIL_FP = 'tail-fp-aaa'
const HEAD_OLD = 'head-fp-old'
const HEAD_NEW = 'head-fp-new'

/** 一份【当初带着分界关键帧烧出来的】母带旁挂文件 */
const GOOD_STAMP: Stamp = {
  fingerprint: 'master-fp', status: 'done',
  boundaryMs: BOUNDARY, headFingerprint: HEAD_OLD, tailFingerprint: TAIL_FP,
  keyframeForced: true,
}

/** 用户刚重选了开头:后半段没变,只有 head 变了 */
function film (over: Partial<FilmPlan> = {}): FilmPlan {
  return {
    plan: { segments: [], totalMs: 0 },
    split: { boundaryMs: BOUNDARY, head: HEAD_NEW, tail: TAIL_FP, headSegmentCount: 3 },
    ...over,
  } as FilmPlan
}

async function seed (stamp: Stamp | null, opts: { master?: boolean } = {}): Promise<void> {
  if (opts.master !== false) await writeFile(join(dir, FILM_MASTER_FILE), 'x')
  if (stamp !== null) await writeFile(join(dir, MASTER_STAMP_FILE), JSON.stringify(stamp))
}

describe('可以只换开头', () => {
  it('后半段的指纹没变、分界没挪、当初强制过关键帧 → 放行', async () => {
    await seed(GOOD_STAMP)
    expect(await planHeadSwap(dir, film())).toEqual({ boundaryMs: BOUNDARY, headSegmentCount: 3 })
  })
})

describe('三道闸，少一道都不换', () => {
  /*
   * ⚠️ 最要紧的一条。加这个功能之前烧的母带在分界处【没有关键帧】,
   * 而分界照样算得出来。照着切的话 ffmpeg 不报错,只是悄悄退到前一个
   * 关键帧、把整条都搬进"后半段"——实测拼出来多 225 帧,时长元数据却正常。
   */
  it('当初没强制关键帧 → 整条重烧', async () => {
    await seed({ ...GOOD_STAMP, keyframeForced: undefined })
    expect(await planHeadSwap(dir, film())).toBeNull()
  })

  /* 后半段是从那一毫秒切下来的,分界一变它的起点就对不上新的时间轴 */
  it('分界挪过了 → 整条重烧', async () => {
    await seed({ ...GOOD_STAMP, boundaryMs: 25_000 })
    expect(await planHeadSwap(dir, film())).toBeNull()
  })

  /* 字幕/配音/时长/画幅任一变化都会让它变——那时后半段本身就该重烧 */
  it('后半段的指纹变了 → 整条重烧', async () => {
    await seed({ ...GOOD_STAMP, tailFingerprint: '别的' })
    expect(await planHeadSwap(dir, film())).toBeNull()
  })
})

describe('别的拦不住的情况', () => {
  it('这条片子本来就不支持拆(老项目) → null', async () => {
    await seed(GOOD_STAMP)
    expect(await planHeadSwap(dir, film({ split: null }))).toBeNull()
  })

  it('自备背景视频,没有"开头那几段"可换 → null', async () => {
    await seed(GOOD_STAMP)
    expect(await planHeadSwap(dir, film({ plan: null }))).toBeNull()
  })

  it('母带不在了(归档过) → null', async () => {
    await seed(GOOD_STAMP, { master: false })
    expect(await planHeadSwap(dir, film())).toBeNull()
  })

  it('旁挂文件不在 → null', async () => {
    await seed(null)
    expect(await planHeadSwap(dir, film())).toBeNull()
  })

  it('旁挂文件是坏的 → null，且不抛', async () => {
    await writeFile(join(dir, FILM_MASTER_FILE), 'x')
    await writeFile(join(dir, MASTER_STAMP_FILE), '{{{ 不是 JSON')
    await expect(planHeadSwap(dir, film())).resolves.toBeNull()
  })

  /* 上一次烧到一半 → 盘上那条母带是半截的,切它等于拿垃圾拼 */
  it('上一次没烧完(status 不是 done) → null', async () => {
    await seed({ ...GOOD_STAMP, status: 'building' })
    expect(await planHeadSwap(dir, film())).toBeNull()
  })

  /*
   * 开头也没变 = 根本没什么要换的。这种情况该由母带指纹直接命中复用,
   * 走到这里说明是别的东西变了,不该用"只换开头"去糊弄过去。
   */
  it('开头的指纹也没变 → null', async () => {
    await seed(GOOD_STAMP)
    expect(await planHeadSwap(dir, film({
      split: { boundaryMs: BOUNDARY, head: HEAD_OLD, tail: TAIL_FP, headSegmentCount: 3 },
    }))).toBeNull()
  })

  it('目录根本不存在 → null，且不抛', async () => {
    await expect(planHeadSwap(join(dir, '没这个目录'), film())).resolves.toBeNull()
  })
})

describe('文件名两处要对上', () => {
  /*
   * reopen.ts 故意写字面量 'master.mp4' / 'master.json' 而不 import film.js:
   * 之前 archive.ts → film.js 的模块级引用撞过 TDZ,一个 ReferenceError
   * 让【所有】导出请求 500。字面量换来的是没有循环依赖,代价是这个断言。
   */
  it('reopen.ts 里的字面量和 film.ts 的常量一致', () => {
    expect(FILM_MASTER_FILE).toBe('master.mp4')
    expect(MASTER_STAMP_FILE).toBe('master.json')
  })
})
