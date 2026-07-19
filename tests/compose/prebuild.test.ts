import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planFingerprint, bgTrackJobId, BG_TRACK_FILE,
  writeStamp, reusableBgTrack,
} from '../../src/compose/prebuild.js'
import type { BgSegment } from '../../src/library/background.js'
import type { AspectPreset } from '../../src/types.js'

const ASPECT: AspectPreset = { name: '9:16', width: 1080, height: 1920 }
const OTHER: AspectPreset = { name: '1:1', width: 1080, height: 1080 }

function seg (over: Partial<BgSegment> = {}): BgSegment {
  // 【不用 as BgSegment 硬转】：字段名写错了要当场编译失败，
  // 而不是跑到 ffmpeg 那一步才炸（fitMode 那次就是这么来的）
  return {
    itemId: '1-开头/a.mp4', filename: 'a.mp4', bucket: '1-开头',
    startMs: 0, takeMs: 1000, ...over,
  }
}

describe('planFingerprint —— 排布变了就该重拼', () => {
  it('同一份排布永远算出同一个指纹', () => {
    const a = [seg(), seg({ bucket: '2-常规', itemId: '2-常规/b.mp4', takeMs: 2000 })]
    expect(planFingerprint(a, ASPECT)).toBe(planFingerprint([...a], ASPECT))
  })

  it('换了素材 → 指纹变', () => {
    expect(planFingerprint([seg()], ASPECT))
      .not.toBe(planFingerprint([seg({ itemId: '1-开头/别的.mp4' })], ASPECT))
  })

  it('取的时长变了 → 指纹变', () => {
    expect(planFingerprint([seg()], ASPECT))
      .not.toBe(planFingerprint([seg({ takeMs: 1001 })], ASPECT))
  })

  it('起点变了 → 指纹变', () => {
    expect(planFingerprint([seg()], ASPECT))
      .not.toBe(planFingerprint([seg({ startMs: 500 })], ASPECT))
  })

  it('顺序变了 → 指纹变（先跑酷后开头是另一条片子）', () => {
    const a = seg()
    const b = seg({ itemId: '3-地铁跑酷/c.mp4', bucket: '3-地铁跑酷' })
    expect(planFingerprint([a, b], ASPECT)).not.toBe(planFingerprint([b, a], ASPECT))
  })

  it('段数变了 → 指纹变', () => {
    expect(planFingerprint([seg()], ASPECT)).not.toBe(planFingerprint([seg(), seg()], ASPECT))
  })

  it('画幅变了 → 指纹变', () => {
    /*
     * 排布没动，但轨是按画幅烧出来的：9:16 拼好的轨拿去当 1:1 的背景，
     * 画面比例整个是错的。指纹必须把画幅算进去。
     */
    expect(planFingerprint([seg()], ASPECT)).not.toBe(planFingerprint([seg()], OTHER))
  })

  it('不同素材的拼接不会被分隔符糊在一起', () => {
    /*
     * 朴素的 `id + takeMs` 直接串起来会让 ('ab', 1) 和 ('a', 'b1') 撞车。
     * 素材 id 是「桶名/文件名」，里面什么字符都有。
     */
    expect(planFingerprint([seg({ itemId: 'ab', takeMs: 1 })], ASPECT))
      .not.toBe(planFingerprint([seg({ itemId: 'a', takeMs: 1 })], ASPECT))
  })
})

describe('bgTrackJobId', () => {
  it('按项目区分，不会两个项目抢同一个队列位', () => {
    expect(bgTrackJobId('aaa')).not.toBe(bgTrackJobId('bbb'))
  })

  it('和导出作业的 id（UUID）不可能撞车', () => {
    // 撞了的话，一次预拼会把用户正在看的导出进度覆盖掉
    expect(bgTrackJobId('aaa')).toContain('bgtrack')
  })
})

describe('reusableBgTrack —— 什么时候能直接用现成的轨', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sj-prebuild-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const FP = 'abc123'

  async function putTrack (bytes = 'x'): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, BG_TRACK_FILE), bytes)
  }

  it('文件在、指纹对得上 → 返回路径，导出可以跳过生成', async () => {
    await putTrack()
    await writeStamp(dir, FP)
    expect(await reusableBgTrack(dir, FP)).toBe(join(dir, BG_TRACK_FILE))
  })

  it('指纹对不上 → null，必须重拼', async () => {
    await putTrack()
    await writeStamp(dir, FP)
    expect(await reusableBgTrack(dir, '另一个指纹')).toBe(null)
  })

  it('有指纹但文件没了（手工删过 data/、盘满回滚）→ null', async () => {
    await writeStamp(dir, FP)
    expect(await reusableBgTrack(dir, FP)).toBe(null)
  })

  it('有文件但没有指纹（老项目留下的轨）→ null，说不清新旧就别用', async () => {
    await putTrack()
    expect(await reusableBgTrack(dir, FP)).toBe(null)
  })

  it('0 字节的文件不算数——半个 mp4 会让成片毁掉', async () => {
    await putTrack('')
    await writeStamp(dir, FP)
    expect(await reusableBgTrack(dir, FP)).toBe(null)
  })

  it('指纹文件是坏 JSON 也只回 null，绝不抛——这条路上的失败不许影响导出', async () => {
    await putTrack()
    await writeFile(join(dir, 'bg-track.json'), '{半个')
    await expect(reusableBgTrack(dir, FP)).resolves.toBe(null)
  })

  it('目录根本不存在也只回 null', async () => {
    await expect(reusableBgTrack(join(dir, '没有这个目录'), FP)).resolves.toBe(null)
  })
})
