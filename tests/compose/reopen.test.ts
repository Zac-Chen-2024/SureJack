import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planHeadSwap, pickCutPoint } from '../../src/compose/reopen.js'
import { buildArgs } from '../../src/render/ffmpeg.js'
import type { AspectPreset, RenderJob } from '../../src/types.js'
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

const ASPECT: AspectPreset = { width: 1080, height: 1920 } as AspectPreset
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

describe('这一刀到底落在哪一毫秒', () => {
  /*
   * ⚠️ 这一组是【线上端到端跑出来的两个真 bug】钉成的回归测试。
   *
   * 烧录时 `-force_key_frames 5.960` 并不在 5.960 放帧——它在第一个
   * pts ≥ 5.960 的帧上放，30fps 下是 5.966667。而 `-ss 5.960 -c copy`
   * 找的是"不晚于 5.960 的关键帧"，于是退回 0.000，把【整条片子】
   * 都当成后半段搬走。
   *
   * 实测：拼出来 779 帧（应该 600），多的正好是一整段旧开头，
   * 而 ffprobe 报的时长只差 1 毫秒——看着完全正常。
   */
  const KEYS = [0, 5.966667, 14.3]

  it('取分界【之后】那个关键帧，不是之前的', () => {
    expect(pickCutPoint(KEYS, 5960)).toBe(5.966667)
  })

  it('绝不会退回分界【之前】的关键帧（那会把整条片子当成后半段）', () => {
    expect(pickCutPoint(KEYS, 5960)).not.toBe(0)
  })

  /*
   * 我们烧的时候【就在分界处】强制过一帧，所以找到的必然贴着分界。
   * 差出一帧以上说明那一帧根本不在，找到的是别处一个碰巧的关键帧——
   * 照它切，接缝就跑到了别的地方：头段比挑的开头素材还长。
   */
  it('找到的关键帧离分界太远 → null（那一帧根本不在）', () => {
    expect(pickCutPoint(KEYS, 100)).toBeNull()
    expect(pickCutPoint([0, 9.5], 5960)).toBeNull()
  })

  it('差不到一帧 → 照收', () => {
    expect(pickCutPoint([0, 5.966667], 5940)).toBe(5.966667)   // 差 26.7ms < 33.3ms
  })

  /* 分界正好压在关键帧上时，浮点抖动不该让我们跳到下一个 */
  it('分界正好等于关键帧时就取它，不跳下一个', () => {
    expect(pickCutPoint(KEYS, 5966.667)).toBe(5.966667)
    expect(pickCutPoint(KEYS, 5967)).toBe(5.966667)
  })

  it('一个关键帧都在分界之前 → null（不能拆）', () => {
    expect(pickCutPoint([0, 1, 2], 5960)).toBeNull()
  })

  it.each([['0', 0], ['负数', -1], ['NaN', Number.NaN]])('分界是%s → null', (_l, ms) => {
    expect(pickCutPoint(KEYS, ms)).toBeNull()
  })
})

describe('头段按【帧数】烧，不按时间', () => {
  /*
   * ⚠️ 第二个真 bug。切点落在某一帧的 pts 上（5.966667），拿时间去截
   * 只能在多一帧和少一帧之间猜：`-t 5.967` 会把属于后半段的那一帧也
   * 收进来 → 拼起来 601 帧 → 被守卫拦下、白白退回整条重烧。
   */
  const job = (extra: Partial<RenderJob>): RenderJob => ({
    silentMaster: true,
    clips: [{ path: '/bg.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
    voicePath: '/v.mp3', bgmVolume: 0.1, assPath: '/s.ass',
    aspect: ASPECT, durationMs: 5967, outPath: '/out.mp4', ...extra,
  })

  it('给了 frames → 用 -frames:v，不出现 -t', () => {
    const args = buildArgs(job({ frames: 179 }))
    expect(args[args.indexOf('-frames:v') + 1]).toBe('179')
    expect(args.includes('-t')).toBe(false)
  })

  /* 平时(整条烧录)必须还走 -t：改了会让重烧出来的片子和从前差一帧 */
  it.each([['没给', undefined], ['是 0', 0], ['不是整数', 12.5], ['负数', -3]])(
    'frames %s → 仍旧按时间截断', (_l, frames) => {
      const args = buildArgs(job({ frames }))
      expect(args.includes('-frames:v')).toBe(false)
      expect(args[args.indexOf('-t') + 1]).toBe('6.0')
    })
})
