import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildArgs } from '../../src/render/ffmpeg.js'
import type { RenderJob } from '../../src/types.js'

const run = promisify(execFile)

/*
 * BGM 必须【循环】铺满配音全长。
 *
 * 原来的实现只有 amix=duration=first：BGM 比配音长会截断（对），但比配音
 * 短时放完就静音，剩下全程没有背景音乐。实测素材库里 9 首 BGM 是 7.6–11.6
 * 分钟，而一条 13 分钟的片子——用最短的那首会有 5.5 分钟全程没音乐。
 *
 * 【这个测试不能只看时长】：静音的那一段也算时长，时长本来就是对的。
 * 必须量音频能量，才能区分「有声音」和「有一段安静的音轨」。
 */

let dir: string
let bgVideo: string, voice: string, bgm: string, ass: string

/** 量一段时间窗内的平均音量（dB）。完全静音时 ffmpeg 报 -91dB 或更低 */
async function meanVolumeDb (file: string, startSec: number, durSec: number): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-ss', String(startSec), '-t', String(durSec), '-i', file,
    '-af', 'volumedetect', '-f', 'null', '-',
  ])
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
  if (!m?.[1]) throw new Error('没能从 volumedetect 里读出平均音量')
  return Number(m[1])
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bgm-loop-'))
  bgVideo = join(dir, 'bg.mp4')
  voice = join(dir, 'voice.mp3')
  bgm = join(dir, 'bgm.mp3')
  ass = join(dir, 'sub.ass')

  // 背景视频 10 秒
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=10',
    '-pix_fmt', 'yuv420p', bgVideo])
  // 配音 10 秒（近乎静音，好让 BGM 的能量凸显出来）
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
    '-t', '10', voice])
  // BGM 只有 2 秒 —— 【故意】远短于配音，这才是要测的情形
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000',
    '-t', '2', '-ac', '1', bgm])

  await writeFile(ass, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Sub,Noto Sans CJK SC,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,120,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n'), 'utf8')
}, 120_000)

afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/*
 * 【不要用 `as RenderJob` 硬转】：第一版就是这么写的，把 fitMode 误写成 fit
 * 而类型检查完全没报错，一路跑到 ffmpeg 才炸出「No such filter: ''」。
 * 老老实实写全字段，让编译器替你把关。
 */
function makeJob (outPath: string): RenderJob {
  return {
    clips: [{
      path: bgVideo, fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5,
    }],
    voicePath: voice,
    bgmPath: bgm,
    bgmVolume: 0.5,
    assPath: ass,
    aspect: { width: 1080, height: 1920 },
    durationMs: 10_000,
    outPath,
  }
}

describe('BGM 循环铺满', () => {
  it('参数里对 BGM 输入加了 -stream_loop -1', () => {
    const job = makeJob(join(dir, 'out.mp4'))

    const args = buildArgs(job)
    const bgmIdx = args.indexOf(bgm)
    expect(bgmIdx).toBeGreaterThan(-1)
    // -stream_loop -1 必须【紧挨着】BGM 的 -i 之前：ffmpeg 的输入选项只作用于
    // 它后面那一个 -i，放错位置会去循环配音甚至背景视频
    expect(args.slice(bgmIdx - 3, bgmIdx)).toEqual(['-stream_loop', '-1', '-i'])
  })

  it('BGM 只有 2 秒、配音 10 秒时，成片最后一秒仍然有声音', async () => {
    const out = join(dir, 'looped.mp4')
    const job = makeJob(out)

    await run('ffmpeg', buildArgs(job))

    const head = await meanVolumeDb(out, 0.5, 1)     // BGM 原本就覆盖的一段
    const tail = await meanVolumeDb(out, 8.5, 1)     // 只有循环了才有声音的一段

    // 静音是 -91dB 量级；有正弦波时远高于此
    expect(tail).toBeGreaterThan(-60)
    // 首尾能量应当接近——真循环了才会这样，而不是尾部衰减成静音
    expect(Math.abs(tail - head)).toBeLessThan(6)
  }, 120_000)
})
