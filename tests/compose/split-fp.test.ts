import { describe, it, expect } from 'vitest'
import { splitFingerprints, splitAt, type SplitInput } from '../../src/compose/split-fp.js'
import { buildArgs } from '../../src/render/ffmpeg.js'
import type { BgSegment } from '../../src/library/background.js'
import type { AspectPreset, RenderJob } from '../../src/types.js'

/*
 * 母带身份拆两半。**这是「重选开头只重烧一两分钟」的判据**:
 * 后半段的指纹没变 → 盘上那条母带的后半段能原样拼回去。
 *
 * 判错的代价是不对称的:
 * · 该复用却判成不能 → 慢十几分钟,没别的坏处
 * · 不该复用却判成能 → 拼出一条【前后对不上】的片子发给用户
 * 所以这一组的重点全在后一种。
 */

const ASPECT: AspectPreset = { width: 1080, height: 1920 } as AspectPreset

const seg = (itemId: string, takeMs: number): BgSegment =>
  ({ itemId, bucket: '1-开头', startMs: 0, takeMs } as BgSegment)

/** 开头 3 段共 30 秒(分界),后面 2 段 */
const SEGS: BgSegment[] = [
  seg('kai-a', 10_000), seg('kai-b', 10_000), seg('kai-c', 10_000),
  seg('chang-a', 60_000), seg('pao-a', 200_000),
]

const BASE: SplitInput = {
  aspect: ASPECT, durationMs: 290_000, ass: 'ASS 全文', boundaryMs: 30_000,
  segments: SEGS, rest: ['voice.mp3', '晓辰', 0, 0, 0, '', ''],
}

describe('切点', () => {
  it('累加正好等于分界时切在那一段之后', () => {
    expect(splitAt(SEGS, 30_000)).toBe(3)
  })

  /*
   * 【对不上就不切】。定长开头保证累加必然正好落在分界上;对不上说明
   * 这条排布不是按分界铺的(老项目、或者规则变过),这时候切开会切在
   * 一段素材的中间,后半段的第一帧就不是我们以为的那一帧。
   */
  it.each([
    ['分界落在某段中间', 25_000],
    ['分界比整条还长', 999_999],
    ['分界是 0', 0],
    ['分界是负数', -1],
  ])('%s → 不能拆', (_label, boundary) => {
    expect(splitAt(SEGS, boundary)).toBeNull()
  })

  it('切在最后一段末尾 = 后半段是空的 → 不能拆', () => {
    expect(splitAt(SEGS, 290_000)).toBeNull()
  })
})

describe('换开头,后半段的指纹不动', () => {
  /* 这一条成立,整个功能才有意义 */
  it('开头素材整批换掉:head 变、tail 一个字节不变', () => {
    const before = splitFingerprints(BASE)!
    const after = splitFingerprints({
      ...BASE,
      segments: [seg('kai-x', 15_000), seg('kai-y', 15_000), SEGS[3]!, SEGS[4]!],
    })!
    expect(after.tail).toBe(before.tail)
    expect(after.head).not.toBe(before.head)
  })

  it('开头段的顺序换一下也只动 head', () => {
    const before = splitFingerprints(BASE)!
    const after = splitFingerprints({
      ...BASE, segments: [SEGS[2]!, SEGS[1]!, SEGS[0]!, SEGS[3]!, SEGS[4]!],
    })!
    expect(after.tail).toBe(before.tail)
    expect(after.head).not.toBe(before.head)
  })
})

describe('别的东西一变,后半段就作废', () => {
  const before = splitFingerprints(BASE)!

  it.each([
    ['字幕改了', { ass: 'ASS 全文（改过）' }],
    ['配音重做、总长变了', { durationMs: 291_000 }],
    ['画幅换了', { aspect: { width: 1920, height: 1080 } as AspectPreset }],
    ['分界挪了', { boundaryMs: 20_000 }],
    ['后半段的排布变了', { segments: [...SEGS.slice(0, 3), seg('chang-b', 60_000), SEGS[4]!] }],
    ['水印/断点/配音参数变了', { rest: ['voice.mp3', '晓辰', 0, 0, 0, '出品', ''] }],
  ])('%s → tail 变 → 整条重烧', (_label, patch) => {
    const after = splitFingerprints({ ...BASE, ...patch } as SplitInput)
    expect(after?.tail).not.toBe(before.tail)
  })

  /*
   * ⚠️ 分界挪了尤其要紧:后半段是从【那一刻】切下来的,分界一变,
   * 盘上那份后半段的起点就对不上新的时间轴,拼出来会重播或漏掉几句话。
   */
  it('分界挪了 head 也必须变', () => {
    expect(splitFingerprints({ ...BASE, boundaryMs: 20_000 })?.head).not.toBe(before.head)
  })
})

describe('拆不开时返回 null,不抛', () => {
  it('排布和分界对不上', () => {
    expect(splitFingerprints({ ...BASE, boundaryMs: 25_000 })).toBeNull()
  })

  it('没有排布(自备背景视频)', () => {
    expect(splitFingerprints({ ...BASE, segments: [] })).toBeNull()
  })
})

describe('烧录时在分界处强制关键帧', () => {
  const job = (extra: Partial<RenderJob>): RenderJob => ({
    silentMaster: true,
    clips: [{ path: '/bg.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
    voicePath: '/voice.mp3', bgmVolume: 0.1, assPath: '/s.ass',
    aspect: ASPECT, durationMs: 290_000, outPath: '/out.mp4', ...extra,
  })

  it('给了分界 → 参数里出现 -force_key_frames，值是秒', () => {
    const args = buildArgs(job({ keyframeAtMs: 30_000 }))
    const at = args.indexOf('-force_key_frames')
    expect(at).toBeGreaterThan(0)
    expect(args[at + 1]).toBe('30.000')
  })

  /*
   * ⚠️ 这一条是【老项目的隔离】。多一个 -force_key_frames 就是另一套编码
   * 参数,烧出来的字节和从前不同。老项目 headBoundaryMs 是 null,
   * 必须一个参数都不加。
   */
  it.each([
    ['没给', undefined],
    ['是 null', null],
    ['是 0', 0],
    ['是负数', -5],
    ['落在片尾之外', 999_999],
  ])('%s → 一个参数都不加', (_label, ms) => {
    expect(buildArgs(job({ keyframeAtMs: ms })).includes('-force_key_frames')).toBe(false)
  })
})
