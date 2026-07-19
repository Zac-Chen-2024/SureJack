import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { masterFingerprint, filmFingerprint, type FilmFingerprintInput } from '../../src/compose/film.js'
import { mixBgm } from '../../src/compose/mix.js'

const run = promisify(execFile)

/**
 * 母带/成片两层拆分。
 *
 * 拆开的全部意义是：换一首背景音乐【不该重烧视频】。实测同一条 10 分钟的
 * 片子，整条重烧 12 分钟、只重混音频 9 秒——80 倍。所以这里最要紧的断言
 * 就一条：改 BGM 时母带指纹必须一个字都不变。那条一破，优化立刻归零，
 * 而且症状只是"有点慢"，没人会发现。
 */

const BASE: FilmFingerprintInput = {
  aspect: { name: '9:16', width: 1080, height: 1920 },
  durationMs: 60_000,
  bgKey: 'plan:abc123',
  ass: '[Script Info]\nPlayResX: 1080\n',
  voicePath: '/data/甲/assets/p1/voice.mp3',
  bgmPath: '/data/library/背景音乐/一笑倾城.mp3',
  bgmVolume: 0.15,
}

describe('指纹分两层', () => {
  it('【换 BGM：母带指纹不变，成片指纹变】这是整个优化成立的前提', () => {
    const other = { ...BASE, bgmPath: '/data/library/背景音乐/傻女.mp3' }
    expect(masterFingerprint(other)).toBe(masterFingerprint(BASE))
    expect(filmFingerprint(other)).not.toBe(filmFingerprint(BASE))
  })

  it('【调音量：同理】音量只影响混音那一步', () => {
    const other = { ...BASE, bgmVolume: 0.3 }
    expect(masterFingerprint(other)).toBe(masterFingerprint(BASE))
    expect(filmFingerprint(other)).not.toBe(filmFingerprint(BASE))
  })

  it('【不要 BGM 了：母带仍然不变】', () => {
    const other = { ...BASE, bgmPath: null }
    expect(masterFingerprint(other)).toBe(masterFingerprint(BASE))
    expect(filmFingerprint(other)).not.toBe(filmFingerprint(BASE))
  })

  /*
   * 反过来：改字幕、改文案、换配音、换背景排布，这些是真的要重烧的。
   * 漏掉任何一条，用户改完设置下到的还是老片子——而这种 bug 不可自证。
   */
  it.each([
    ['字幕/文案（ASS 变了）', { ass: '[Script Info]\nPlayResX: 1080\nMarginV: 520\n' }],
    ['配音换了', { voicePath: '/data/甲/assets/p1/voice2.mp3' }],
    ['背景排布变了', { bgKey: 'plan:def456' }],
    ['时长变了', { durationMs: 61_000 }],
    ['画幅变了', { aspect: { name: '16:9', width: 1920, height: 1080 } }],
  ])('【%s → 母带必须重烧】', (_label, patch) => {
    const other = { ...BASE, ...patch } as FilmFingerprintInput
    expect(masterFingerprint(other)).not.toBe(masterFingerprint(BASE))
    expect(filmFingerprint(other)).not.toBe(filmFingerprint(BASE))
  })
})

describe('混音（真跑 ffmpeg）', () => {
  it('视频流原样保留、音频被换掉，且旧成片在完成前一直有效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mix-'))
    try {
      const master = join(dir, 'master.mp4')
      const bgm = join(dir, 'bgm.mp3')
      const out = join(dir, 'export.mp4')

      // 3 秒的画面 + 一条正弦波当"配音"
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=d=3:s=320x568:r=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', master])
      // BGM 故意比母带短，验证循环铺满
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', bgm])

      // 先放一个"旧成片"在目标位置，混音期间它必须一直是完整的
      await writeFile(out, 'OLD-FILM-CONTENT')

      await mixBgm({ masterPath: master, bgmPath: bgm, bgmVolume: 0.15, outPath: out })

      /*
       * 【比视频码流的 md5，不比 codec/分辨率】。
       *
       * 踩过：一开始断言的是 codec_name/width/height 一致，结果把 -c:v copy
       * 换成 libx264 重编码，测试【照样全绿】——重编码出来仍然是 h264、
       * 仍然是那个分辨率。那条断言看起来在守着优化，其实什么都没守。
       *
       * md5 相同才真正说明码流一个字节没动，也就是真的 copy 了。
       * -c copy -f md5 让 ffmpeg 只搬运不解码，正好给出这个值。
       */
      const streamMd5 = async (p: string) => {
        const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', p,
          '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'])
        return stdout.trim()
      }
      expect(await streamMd5(out)).toBe(await streamMd5(master))

      // 长度跟着母带走（duration=first），BGM 短也不会把成片截短
      const dur = async (p: string) => Number((await run('ffprobe', ['-v', 'error',
        '-show_entries', 'format=duration', '-of', 'csv=p=0', p])).stdout.trim())
      expect(await dur(out)).toBeCloseTo(await dur(master), 0)

      // 临时文件不能留在盘上
      await expect(stat(`${out}.partial.mp4`)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  /*
   * 线上真事：拖了一下字幕高度触发重合，465MB 的成片当场变成 35MB 的残片，
   * 播不了也下不了——因为渲染是【就地覆盖】唯一那份能用的成片。
   * 写临时文件再 rename 之后，失败时旧文件必须原封不动。
   */
  it('【混音失败不能毁掉旧成片】写临时文件再 rename 的全部意义', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mix-fail-'))
    try {
      const out = join(dir, 'export.mp4')
      await writeFile(out, 'OLD-FILM-CONTENT')

      await expect(mixBgm({
        masterPath: join(dir, '根本不存在.mp4'),
        bgmPath: join(dir, '也不存在.mp3'),
        bgmVolume: 0.15, outPath: out,
      })).rejects.toThrow()

      // 旧成片必须还在，且一个字节都没变
      const { stdout } = await run('cat', [out])
      expect(stdout).toBe('OLD-FILM-CONTENT')
      // 半成品要收走，别留一个看着像成片的残file
      await expect(stat(`${out}.partial.mp4`)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
