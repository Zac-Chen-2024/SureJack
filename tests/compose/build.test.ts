import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBackgroundTrack, segmentArgs, concatListContent } from '../../src/compose/build.js'
import { bucketDir } from '../../src/library/paths.js'
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
