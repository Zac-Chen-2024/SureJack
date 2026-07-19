import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBackgroundTrack, segmentArgs, concatListContent,
  copySegmentArgs, copyTakeMs, canCopySegment, KEYFRAME_MS,
} from '../../src/compose/build.js'
import { bucketDir } from '../../src/library/paths.js'
import { normalizeBucket, normalizedPath, TARGET } from '../../src/library/normalize.js'
import type { AspectPreset } from '../../src/types.js'

const run = promisify(execFile)

/** 小画幅，测试跑得快。归一化逻辑与画幅大小无关。 */
const ASPECT: AspectPreset = { name: 'test', width: 180, height: 320 }

/**
 * 现生成一个带音轨的小视频。
 *
 * 【绝不扫真实素材库】——data/library 是 8.5GB，地铁跑酷单文件 1GB，
 * ffprobe 慢且会往真实索引里写。这里几十 KB 的 testsrc 就够验证全部逻辑。
 */
async function makeVideo (path: string, seconds: number, size: string): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=${size}:r=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
  ])
}

async function probe (path: string, entries: string, stream: string): Promise<string> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', stream,
    '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ])
  return stdout.trim()
}

describe('segmentArgs —— 单段归一化', () => {
  const seg = { bucket: '3-地铁跑酷', filename: '大文件.mp4', startMs: 90_000, takeMs: 12_500 }

  it('-ss 排在 -i 前面（输入端快速定位）', () => {
    const args = segmentArgs('/lib/3-地铁跑酷/大文件.mp4', seg, ASPECT, '/tmp/out.mp4')
    const ss = args.indexOf('-ss')
    const i = args.indexOf('-i')
    expect(ss).toBeGreaterThanOrEqual(0)
    expect(i).toBeGreaterThanOrEqual(0)
    /*
     * 这条不是风格问题：-ss 放在 -i 后面，ffmpeg 会从文件头一路解码到
     * 截取点。地铁跑酷源文件 1GB，那是几十秒的差别，而每条成片要截好几段。
     */
    expect(ss).toBeLessThan(i)
  })

  it('startMs / takeMs 换算成秒写进 -ss 和 -t', () => {
    const args = segmentArgs('/lib/a.mp4', seg, ASPECT, '/tmp/out.mp4')
    expect(args[args.indexOf('-ss') + 1]).toBe('90.000')
    expect(args[args.indexOf('-t') + 1]).toBe('12.500')
  })

  it('一律 -an 去掉音轨——背景静音是设计约束', () => {
    const args = segmentArgs('/lib/a.mp4', seg, ASPECT, '/tmp/out.mp4')
    expect(args).toContain('-an')
  })

  it('滤镜链把画幅、帧率、像素宽高比全部归一化', () => {
    const args = segmentArgs('/lib/a.mp4', seg, ASPECT, '/tmp/out.mp4')
    const vf = args[args.indexOf('-vf') + 1] ?? ''
    // concat demuxer 要求所有输入参数一致；素材来源杂乱，四样都得钉死
    expect(vf).toContain('scale=180:320')
    expect(vf).toContain('crop=180:320')
    expect(vf).toContain('fps=30')
    expect(vf).toContain('setsar=1')
  })

  it('输出路径是参数的最后一项', () => {
    const args = segmentArgs('/lib/a.mp4', seg, ASPECT, '/tmp/out.mp4')
    expect(args[args.length - 1]).toBe('/tmp/out.mp4')
  })
})

describe('concatListContent', () => {
  it('每行一个 file 指令', () => {
    expect(concatListContent(['/tmp/a.mp4', '/tmp/b.mp4']))
      .toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n")
  })

  it('路径里的单引号被转义，不会把清单撑破', () => {
    expect(concatListContent(["/tmp/it's.mp4"])).toBe("file '/tmp/it'\\''s.mp4'\n")
  })
})

describe('buildBackgroundTrack —— 真跑 ffmpeg', () => {
  let dataDir = ''
  let workRoot = ''

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sj-build-lib-'))
    workRoot = await mkdtemp(join(tmpdir(), 'sj-build-work-'))
    for (const b of ['1-开头', '2-常规', '3-地铁跑酷']) {
      await mkdir(bucketDir(dataDir, b), { recursive: true })
    }
    // 【故意给三段不同的分辨率】：素材库里的片子来源杂乱，
    // 不先归一化的话 concat demuxer 直接拼不起来
    await makeVideo(join(bucketDir(dataDir, '1-开头'), '开头.mp4'), 3, '320x240')
    await makeVideo(join(bucketDir(dataDir, '2-常规'), '常规.mp4'), 3, '640x360')
    await makeVideo(join(bucketDir(dataDir, '3-地铁跑酷'), '跑酷.mp4'), 6, '426x240')
  }, 120_000)

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await rm(workRoot, { recursive: true, force: true })
  })

  const segments = [
    { bucket: '1-开头', filename: '开头.mp4', startMs: 0, takeMs: 1000 },
    { bucket: '2-常规', filename: '常规.mp4', startMs: 0, takeMs: 1000 },
    { bucket: '3-地铁跑酷', filename: '跑酷.mp4', startMs: 2000, takeMs: 2000 },
  ]

  it('拼出与排布等长、画幅统一、无音轨的背景轨', async () => {
    const outPath = join(workRoot, 'track.mp4')
    const pcts: number[] = []
    await buildBackgroundTrack({
      segments, dataDir, aspect: ASPECT, outPath, workRoot,
      onProgress: (p) => pcts.push(p),
    })

    // 总长 4 秒（1+1+2），容差 0.3 秒
    const dur = Number(await probe(outPath, 'format=duration', 'v:0'))
    expect(dur).toBeGreaterThan(3.7)
    expect(dur).toBeLessThan(4.3)

    // 三段来源分辨率各不相同，成片必须是统一的目标画幅
    expect(await probe(outPath, 'stream=width,height', 'v:0')).toBe('180\n320')

    // 【源视频是有音轨的】——输出没有，证明 -an 真的生效了
    expect(await probe(join(bucketDir(dataDir, '1-开头'), '开头.mp4'), 'stream=codec_type', 'a')).toBe('audio')
    expect(await probe(outPath, 'stream=codec_type', 'a')).toBe('')

    // 进度必须动起来：13 分钟的片子生成背景轨不是瞬时的，
    // 不能让导出进度条一直停在 0
    // 【每段都要报一次】：只在最后报个 100 等于没报——那正是"卡在 0% 然后
    // 突然完成"的观感。三段素材，至少要有三次 100 以下的中间进度。
    expect(pcts.filter((p) => p < 100).length).toBeGreaterThanOrEqual(segments.length)
    expect(pcts.every((p) => p >= 0 && p <= 100)).toBe(true)
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts)
    expect(pcts[pcts.length - 1]).toBe(100)
  }, 120_000)

  it('-ss 真的从指定位置截，不是从头截', async () => {
    // testsrc 画面上有秒表，但比对画面太脆；改用一段【超出源文件长度】的
    // 起点：源片 3 秒，从第 2.5 秒起取 1 秒，只能拿到 0.5 秒。
    // 若 -ss 被忽略（从头截），就会足足有 1 秒。
    const outPath = join(workRoot, 'seek.mp4')
    await buildBackgroundTrack({
      segments: [{ bucket: '1-开头', filename: '开头.mp4', startMs: 2500, takeMs: 1000 }],
      dataDir, aspect: ASPECT, outPath, workRoot,
    })
    const dur = Number(await probe(outPath, 'format=duration', 'v:0'))
    expect(dur).toBeLessThan(0.8)
    expect(dur).toBeGreaterThan(0.2)
  }, 120_000)

  it('成功后不留中间片段', async () => {
    const outPath = join(workRoot, 'clean.mp4')
    await buildBackgroundTrack({ segments, dataDir, aspect: ASPECT, outPath, workRoot })
    const left = (await readdir(workRoot)).filter((n) => n.startsWith('bgtrack-'))
    expect(left).toEqual([])
  }, 120_000)

  it('中途失败也要清干净临时目录，并把错误抛出来', async () => {
    const outPath = join(workRoot, 'fail.mp4')
    await expect(buildBackgroundTrack({
      segments: [{ bucket: '1-开头', filename: '根本不存在.mp4', startMs: 0, takeMs: 1000 }],
      dataDir, aspect: ASPECT, outPath, workRoot,
    })).rejects.toThrow()
    const left = (await readdir(workRoot)).filter((n) => n.startsWith('bgtrack-'))
    expect(left).toEqual([])
  }, 120_000)

  it('未知桶名被拒——素材库没有第二道路径防线', async () => {
    await mkdir(join(workRoot, 'evil'), { recursive: true })
    await writeFile(join(workRoot, 'evil', 'x.mp4'), 'not a video')
    await expect(buildBackgroundTrack({
      segments: [{ bucket: '../../evil', filename: 'x.mp4', startMs: 0, takeMs: 1000 }],
      dataDir, aspect: ASPECT, outPath: join(workRoot, 'evil.mp4'), workRoot,
    })).rejects.toThrow('未知的素材桶')
  })

  it('空排布直接报错，不产出一个 0 秒的成片', async () => {
    await expect(buildBackgroundTrack({
      segments: [], dataDir, aspect: ASPECT, outPath: join(workRoot, 'empty.mp4'), workRoot,
    })).rejects.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 拷贝切片：素材已归一化时，切片不再重新编码，直接搬压缩帧
// ═══════════════════════════════════════════════════════════════════════

describe('copyTakeMs —— 每段向上取整，宁长勿短', () => {
  it('比请求的时长长，绝不短', () => {
    for (const ms of [1, 999, 1000, 1001, 12_500, 60_000]) {
      expect(copyTakeMs(ms), `takeMs=${ms}`).toBeGreaterThan(ms)
    }
  })

  it('多出来的余量至少一个关键帧间隔', () => {
    /*
     * 【为什么必须留余量】：`-c copy` 的切点吸附到关键帧，而且末尾会
     * 截到最后一个完整帧——请求 1.000s 实测可能只给 0.967s。短了之后
     * 烧录那步的 `-stream_loop -1` 会让背景从头循环，接缝处画面突然
     * 跳回开头，非常显眼。总长由烧录的 `-t` 精确截断，所以长是免费的。
     */
    expect(copyTakeMs(3000) - 3000).toBeGreaterThanOrEqual(KEYFRAME_MS)
  })
})

describe('canCopySegment —— 什么时候才允许拷贝', () => {
  const norm = '/data/library/_normalized/1-开头/a.mp4'
  const raw = '/data/library/1-开头/a.mp4'
  const target: AspectPreset = { name: '9:16', width: TARGET.width, height: TARGET.height }

  it('取到的是归一化版、且画幅就是归一化的目标规格 → 拷贝', () => {
    expect(canCopySegment(norm, norm, target)).toBe(true)
  })

  it('没归一化过（取到原文件）→ 必须重新编码', () => {
    // 原文件规格杂乱（720x1280 / 1844x4096 都有），拷贝拼不起来
    expect(canCopySegment(raw, norm, target)).toBe(false)
  })

  it('画幅不是归一化的目标规格 → 必须重新编码', () => {
    /*
     * 【这条最容易漏】：归一化产物固定 1080x1920，导出到别的画幅时
     * 直接拷贝，会把 1080x1920 的段和现编码出来的段拼在一起——
     * concat demuxer 对这种不一致不一定报错，产物可能只有第一段能播。
     */
    expect(canCopySegment(norm, norm, { name: '1:1', width: 1080, height: 1080 })).toBe(false)
    expect(canCopySegment(norm, norm, { name: '16:9', width: 1920, height: 1080 })).toBe(false)
  })
})

describe('copySegmentArgs —— 拷贝路径的参数', () => {
  const seg = { bucket: '1-开头', filename: 'a.mp4', startMs: 90_000, takeMs: 12_500 }

  it('-ss 仍排在 -i 前面', () => {
    const args = copySegmentArgs('/n/a.mp4', seg, '/tmp/out.mp4')
    expect(args.indexOf('-ss')).toBeGreaterThanOrEqual(0)
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })

  it('-c copy：不重新编码，这就是快 175 倍的全部原因', () => {
    const args = copySegmentArgs('/n/a.mp4', seg, '/tmp/out.mp4')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    // 有一个 -vf 就等于在解码重编码，那这条路径的意义就没了
    expect(args).not.toContain('-vf')
    expect(args).not.toContain('-c:v')
  })

  it('一律 -an——背景静音是设计约束，换条路径也不放松', () => {
    expect(copySegmentArgs('/n/a.mp4', seg, '/tmp/out.mp4')).toContain('-an')
  })

  it('-t 用的是补过余量的时长，不是原样的 takeMs', () => {
    const args = copySegmentArgs('/n/a.mp4', seg, '/tmp/out.mp4')
    expect(args[args.indexOf('-t') + 1]).toBe((copyTakeMs(12_500) / 1000).toFixed(3))
  })

  it('输出路径是最后一项', () => {
    expect(copySegmentArgs('/n/a.mp4', seg, '/tmp/x.mp4').at(-1)).toBe('/tmp/x.mp4')
  })
})

/**
 * 拷贝路径的真机验证。
 *
 * ⚠️【这一组绝不能只看总时长】。concat demuxer 把规格不一致的文件拼在
 * 一起时不一定报错——它会产出一个「只有第一段能正常播」的文件，时长
 * 却是对的。所以每个用例都要【真的解码到后面几段】并确认画面内容。
 *
 * 手法：三个源各给一个纯色，拼完之后在每段中点抽一帧、缩成 1x1 读 RGB，
 * 主导通道对不上就说明那一段没解出来（或者拼错了顺序）。
 */
describe('拷贝切片 —— 真跑 ffmpeg', () => {
  let dataDir = ''
  let workRoot = ''
  /** 画幅就是归一化的目标规格，拷贝路径才会被启用 */
  const FULL: AspectPreset = { name: '9:16', width: TARGET.width, height: TARGET.height }

  /** 一个纯色源。短一点，机器上还跑着别的活。 */
  async function makeColor (path: string, color: string, seconds: number, size: string): Promise<void> {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:d=${seconds}:s=${size}:r=25`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
    ])
  }

  /** 在 t 秒处抽一帧，缩成 1x1，返回 [r,g,b] */
  async function pixelAt (path: string, t: number): Promise<[number, number, number]> {
    const { stdout } = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', t.toFixed(3), '-i', path, '-frames:v', '1',
      '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { encoding: 'buffer', maxBuffer: 1 << 20 })
    const buf = stdout as unknown as Buffer
    const [r, g, b] = [buf[0] ?? -1, buf[1] ?? -1, buf[2] ?? -1]
    return [r, g, b]
  }

  /** 主导通道。yuv420p 往返之后纯色会有偏差，只比大小不比绝对值。 */
  function dominant (rgb: readonly [number, number, number]): 'red' | 'green' | 'blue' | '?' {
    const [r, g, b] = rgb
    if (r > g + 40 && r > b + 40) return 'red'
    if (g > r + 40 && g > b + 40) return 'green'
    if (b > r + 40 && b > g + 40) return 'blue'
    return '?'
  }

  /** 从头到尾真解一遍。ffmpeg 只吐 error，有一个字就说明有段坏了。 */
  async function decodesCleanly (path: string): Promise<string> {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', path, '-f', 'null', '-'])
    return String(stderr).trim()
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sj-copy-lib-'))
    workRoot = await mkdtemp(join(tmpdir(), 'sj-copy-work-'))
    for (const b of ['1-开头', '2-常规', '3-地铁跑酷']) {
      await mkdir(bucketDir(dataDir, b), { recursive: true })
    }
    // 【故意给三个不同的源规格】：素材库里本来就是这样，归一化正是为了抹平它
    await makeColor(join(bucketDir(dataDir, '1-开头'), '红.mp4'), 'red', 6, '720x1280')
    await makeColor(join(bucketDir(dataDir, '2-常规'), '绿.mp4'), 'green', 6, '640x360')
    await makeColor(join(bucketDir(dataDir, '3-地铁跑酷'), '蓝.mp4'), 'blue', 6, '480x854')

    /*
     * 【用真的 normalizeBucket 造夹具】，不手写一条等价的 ffmpeg 命令：
     * 拷贝能不能拼起来，取决于归一化产出的确切规格（GOP、pix_fmt、SAR）。
     * 夹具和生产各写一份的话，这里绿了线上照样能坏。
     *
     * 跑酷桶【故意不转】——模拟"归一化还在后台跑，只转完一部分"的真实状态。
     */
    const a = await normalizeBucket(dataDir, '1-开头', ['红.mp4'])
    const b = await normalizeBucket(dataDir, '2-常规', ['绿.mp4'])
    expect(a.failed, '开头桶归一化失败').toEqual([])
    expect(b.failed, '常规桶归一化失败').toEqual([])
  }, 300_000)

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await rm(workRoot, { recursive: true, force: true })
  })

  it('全部归一化：走拷贝，总长不短于请求，且每一段都真的能解出来', async () => {
    const segments = [
      { bucket: '1-开头', filename: '红.mp4', startMs: 0, takeMs: 1000 },
      { bucket: '2-常规', filename: '绿.mp4', startMs: 0, takeMs: 1000 },
      { bucket: '1-开头', filename: '红.mp4', startMs: 2000, takeMs: 1000 },
    ]
    const outPath = join(workRoot, 'all-copy.mp4')
    await buildBackgroundTrack({ segments, dataDir, aspect: FULL, outPath, workRoot })

    // 1) 总长【不能短】——短了烧录时会从头循环，接缝处画面跳回开头
    const requested = segments.reduce((s, x) => s + x.takeMs, 0) / 1000
    const dur = Number(await probe(outPath, 'format=duration', 'v:0'))
    expect(dur).toBeGreaterThanOrEqual(requested)

    // 2) 规格与目标一致、无音轨
    expect(await probe(outPath, 'stream=width,height', 'v:0'))
      .toBe(`${TARGET.width}\n${TARGET.height}`)
    expect(await probe(outPath, 'stream=codec_type', 'a')).toBe('')

    // 3) 【真解码】：整条走一遍，一个 error 都不能有
    expect(await decodesCleanly(outPath)).toBe('')

    // 4) 【每一段都要抽帧看内容】。只看时长的话，"只有第一段能播"的
    //    坏产物同样能过——那正是拷贝路径最典型的失败方式。
    const each = copyTakeMs(1000) / 1000
    expect(dominant(await pixelAt(outPath, each * 0.5))).toBe('red')
    expect(dominant(await pixelAt(outPath, each * 1.5))).toBe('green')
    expect(dominant(await pixelAt(outPath, each * 2.5))).toBe('red')
  }, 300_000)

  it('混合：转过的走拷贝、没转过的走重编码，仍能拼成一条能播到底的轨', async () => {
    /*
     * 这是【当前的真实状态】：开头桶和常规桶转完了，跑酷桶还在后台转。
     * 两条路径的产物必须能首尾相接——这是整个改动风险最高的地方。
     */
    const segments = [
      { bucket: '1-开头', filename: '红.mp4', startMs: 0, takeMs: 1000 },
      { bucket: '3-地铁跑酷', filename: '蓝.mp4', startMs: 0, takeMs: 1000 },
      { bucket: '2-常规', filename: '绿.mp4', startMs: 0, takeMs: 1000 },
    ]
    const outPath = join(workRoot, 'mixed.mp4')
    await buildBackgroundTrack({ segments, dataDir, aspect: FULL, outPath, workRoot })

    const requested = segments.reduce((s, x) => s + x.takeMs, 0) / 1000
    const dur = Number(await probe(outPath, 'format=duration', 'v:0'))
    expect(dur).toBeGreaterThanOrEqual(requested)
    expect(await probe(outPath, 'stream=width,height', 'v:0'))
      .toBe(`${TARGET.width}\n${TARGET.height}`)
    expect(await probe(outPath, 'stream=codec_type', 'a')).toBe('')
    expect(await decodesCleanly(outPath)).toBe('')

    // 段边界：拷贝段被补过余量，重编码段是精确时长
    const copied = copyTakeMs(1000) / 1000
    const encoded = 1
    expect(dominant(await pixelAt(outPath, copied * 0.5))).toBe('red')
    expect(dominant(await pixelAt(outPath, copied + encoded * 0.5))).toBe('blue')
    expect(dominant(await pixelAt(outPath, copied + encoded + copied * 0.5))).toBe('green')
  }, 300_000)

  it('画幅不是归一化目标时，即使素材转过也走重编码——不拿 1080x1920 去凑 1:1', async () => {
    const square: AspectPreset = { name: '1:1', width: 360, height: 360 }
    const outPath = join(workRoot, 'square.mp4')
    await buildBackgroundTrack({
      segments: [
        { bucket: '1-开头', filename: '红.mp4', startMs: 0, takeMs: 1000 },
        { bucket: '2-常规', filename: '绿.mp4', startMs: 0, takeMs: 1000 },
      ],
      dataDir, aspect: square, outPath, workRoot,
    })
    expect(await probe(outPath, 'stream=width,height', 'v:0')).toBe('360\n360')
    expect(await decodesCleanly(outPath)).toBe('')
    expect(dominant(await pixelAt(outPath, 0.5))).toBe('red')
    expect(dominant(await pixelAt(outPath, 1.5))).toBe('green')
  }, 300_000)

  it('归一化产物真的被用上了——不是悄悄退回原文件还碰巧过了', async () => {
    // 这条守住上面那些用例的前提：夹具确实转好了，拷贝路径确实有机会跑
    const norm = normalizedPath(dataDir, '1-开头', '红.mp4')
    expect(canCopySegment(norm, norm, FULL)).toBe(true)
    expect(await probe(norm, 'stream=width,height', 'v:0'))
      .toBe(`${TARGET.width}\n${TARGET.height}`)
  })
})
