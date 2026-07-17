import { describe, it, expect } from 'vitest'
import { parseProgress, buildArgs, createProgressParser } from '../../src/render/ffmpeg.js'
import { ASPECT_PRESETS } from '../../src/config.js'
import type { RenderJob } from '../../src/types.js'

const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  clips: [{ path: '/tmp/v.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
  voicePath: '/tmp/voice.mp3',
  bgmVolume: 0.1,
  assPath: '/tmp/s.ass',
  aspect: ASPECT_PRESETS['9:16']!,
  durationMs: 184200,
  outPath: '/tmp/out.mp4',
  ...over,
})

describe('parseProgress', () => {
  it('从 -progress 输出里解析百分比', () => {
    expect(parseProgress('out_time_ms=92100000', 184200)).toBeCloseTo(50, 0)
  })

  it('无关输出返回 null', () => {
    expect(parseProgress('frame=100\nfps=30', 184200)).toBeNull()
  })

  it('百分比夹在 0..100，不会超过 100', () => {
    expect(parseProgress('out_time_ms=999999000', 184200)).toBe(100)
  })
})

describe('createProgressParser', () => {
  it('完整行正常回调', () => {
    const calls: number[] = []
    const parser = createProgressParser(184200, (pct) => calls.push(pct))
    parser('out_time_ms=92100000\n')
    expect(calls).toEqual([expect.closeTo(50, 0)])
  })

  it('行在 chunk 边界被切断时缓冲并正确解析', () => {
    const calls: number[] = []
    const parser = createProgressParser(184200, (pct) => calls.push(pct))
    // out_time_ms=92100000 被拆成 out_time_ms=921 和 00000\n 两个 chunk
    // 不应该回调 0.0005%，而是正确的 50%，且只回调一次
    parser('out_time_ms=921')
    expect(calls).toEqual([]) // 第一个 chunk 不完整，不应该回调
    parser('00000\n')
    expect(calls).toEqual([expect.closeTo(50, 0)]) // 拼完了才回调
  })

  it('一次多行也正常处理', () => {
    const calls: number[] = []
    const parser = createProgressParser(184200, (pct) => calls.push(pct))
    parser('out_time_ms=46050000\nout_time_ms=92100000\n')
    expect(calls).toEqual([expect.closeTo(25, 0), expect.closeTo(50, 0)])
  })

  it('无关行被忽略', () => {
    const calls: number[] = []
    const parser = createProgressParser(184200, (pct) => calls.push(pct))
    parser('frame=100\nout_time_ms=92100000\nfps=30\n')
    expect(calls).toEqual([expect.closeTo(50, 0)])
  })

  it('最后不完整的行被保留到下次', () => {
    const calls: number[] = []
    const parser = createProgressParser(184200, (pct) => calls.push(pct))
    parser('out_time_ms=46050000\nout_time_ms=921')
    expect(calls).toEqual([expect.closeTo(25, 0)])
    parser('00000\n')
    expect(calls).toEqual([expect.closeTo(25, 0), expect.closeTo(50, 0)])
  })
})

describe('buildArgs', () => {
  it('单片段用 -stream_loop -1 循环输入', () => {
    // 26.5 秒的视频要铺满 184 秒的配音
    expect(buildArgs(job())).toContain('-stream_loop')
  })

  it('输出时长等于配音时长——配音定生死', () => {
    const args = buildArgs(job())
    const i = args.indexOf('-t')
    expect(args[i + 1]).toBe('184.2')
  })

  it('必须 -pix_fmt yuv420p，否则部分播放器和平台不能播', () => {
    expect(buildArgs(job())).toContain('yuv420p')
  })

  it('烧 ASS 时带 fontsdir', () => {
    expect(buildArgs(job()).join(' ')).toContain('fontsdir=/usr/share/fonts/opentype/noto')
  })

  it('不 map 背景视频的音轨——原声一律丢弃', () => {
    const mapped = buildArgs(job()).filter((_, i, a) => a[i - 1] === '-map')
    expect(mapped).toEqual(['[v]', '[aout]'])
    expect(mapped).not.toContain('0:a')
  })

  it('有 BGM 时把它作为第三个输入', () => {
    const args = buildArgs(job({ bgmPath: '/tmp/bgm.mp3' }))
    expect(args).toContain('/tmp/bgm.mp3')
  })

  it('带 -progress pipe:1 才能拿到进度', () => {
    expect(buildArgs(job()).join(' ')).toContain('-progress pipe:1')
  })
})
