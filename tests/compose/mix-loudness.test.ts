import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMixFilter, mixAudio, TARGET_LUFS } from '../../src/compose/mix.js'

const run = promisify(execFile)

/*
 * 用户报「声音小且不可调」。查出来是两件事叠在一起：
 *
 * 1. amix 默认 normalize=1，把每一路除以路数 —— 实测配音因此低了 5.9 分贝
 *    （-21.8 → -27.7 LUFS）。也就是【选了背景音乐的片子比没选的轻 6 分贝】，
 *    而界面上没有任何提示。
 * 2. 就算修好这条，-21.8 LUFS 本身也比短视频平台的惯用响度（约 -14）低。
 *
 * 这个文件钉住这两条的解法。
 */
describe('混音滤镜', () => {
  it('⚠️ amix 必须带 normalize=0', () => {
    const f = buildMixFilter({ voiceGain: 1, bgmVolume: 0.15, hasBgm: true, normalize: false })
    expect(f).toContain('normalize=0')
  })

  it('两路各自有独立增益', () => {
    const f = buildMixFilter({ voiceGain: 1.6, bgmVolume: 0.2, hasBgm: true, normalize: false })
    expect(f).toContain('volume=1.6')
    expect(f).toContain('volume=0.2')
  })

  it('没有 BGM 时也要走配音增益（母带已经没有音轨了）', () => {
    const f = buildMixFilter({ voiceGain: 1.6, bgmVolume: 0.15, hasBgm: false, normalize: false })
    expect(f).toContain('volume=1.6')
    expect(f).not.toContain('amix')
  })

  it('归一化对到平台惯用响度', () => {
    const f = buildMixFilter({ voiceGain: 1, bgmVolume: 0.15, hasBgm: true, normalize: true })
    expect(f).toContain(`loudnorm=I=${TARGET_LUFS}`)
    expect(TARGET_LUFS).toBe(-14)
  })
})

/** 量一段音频的整体响度（LUFS） */
async function lufs (path: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', path,
    '-filter_complex', 'ebur128', '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 32 })
  const m = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].pop()
  if (!m) throw new Error('没量到响度')
  return Number(m[1])
}

describe('真跑 ffmpeg：响度', () => {
  it('【混完不该比配音本身轻】——这正是老版本的毛病', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loud-'))
    try {
      const master = join(dir, 'm.mp4')
      const voice = join(dir, 'v.m4a')
      const bgm = join(dir, 'b.m4a')
      const out = join(dir, 'out.mp4')
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=d=3:s=320x568:r=25',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-an', '-t', '3', master])
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', voice])
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-c:a', 'aac', bgm])

      const before = await lufs(voice)
      await mixAudio({ masterPath: master, voicePath: voice, voiceGain: 1,
        bgmPath: bgm, bgmVolume: 0.15, outPath: out, normalize: false })
      const after = await lufs(out)

      /*
       * 老版本这里会低 6 分贝左右。留 1.5 分贝的余量给 BGM 叠加和
       * aac 编码的正常波动——真正要抓的是"凭空掉一半"那种量级。
       */
      expect(after).toBeGreaterThan(before - 1.5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('【归一化能把小声的片子提上来】', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'norm-'))
    try {
      const master = join(dir, 'm.mp4')
      const voice = join(dir, 'v.m4a')
      const out = join(dir, 'out.mp4')
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=d=3:s=320x568:r=25',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-an', '-t', '3', master])
      // 故意做一条很轻的配音（-30dB）
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-af', 'volume=-30dB', '-c:a', 'aac', voice])

      await mixAudio({ masterPath: master, voicePath: voice, voiceGain: 1,
        bgmPath: null, bgmVolume: 0, outPath: out })
      const after = await lufs(out)

      // 归一化之后该落在目标附近（loudnorm 单遍有几分贝误差，给 5 分贝窗口）
      expect(after).toBeGreaterThan(TARGET_LUFS - 5)
      expect(after).toBeLessThan(TARGET_LUFS + 5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
