import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { shiftWords, synthesizeLong } from '../../src/tts/long.js'
import type { WordTiming } from '../../src/types.js'

const run = promisify(execFile)

/**
 * 假 synthesize 产出的必须是【真的 mp3】，不能是 writeFile('x')。
 * synthesizeLong 里的 concatAudio 没有被注入替换，跑的是真 ffmpeg——
 * 喂它一个内容为 'x' 的文件，拼接会直接失败。
 */
async function silence (path: string, seconds: number): Promise<void> {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'anullsrc=r=24000:cl=mono', '-t', String(seconds), path])
}

const w = (text: string, offsetMs: number, durationMs = 300): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation: false })

describe('shiftWords', () => {
  it('平移只改 offsetMs，不改 durationMs', () => {
    const out = shiftWords([w('他', 0, 250), w('决定', 300, 400)], 5000)
    expect(out.map((x) => x.offsetMs)).toEqual([5000, 5300])
    expect(out.map((x) => x.durationMs)).toEqual([250, 400])
  })

  it('偏移 0 时原样返回', () => {
    expect(shiftWords([w('他', 120)], 0)).toEqual([w('他', 120)])
  })

  /*
   * 返回新数组：调用方可能还要用原始的段内时间轴排查问题。
   *
   * 下面用 toMatchObject 断言整个元素，而不是 orig[0]!.offsetMs 逐字段取。
   * tsconfig 开了 noUncheckedIndexedAccess，索引结果是 T | undefined，
   * 逐字段取要么加 ! 断言（等于关掉这道检查），要么整体比对——后者更好，
   * 因为它顺带把「其他字段没被动过」也一起断言了。
   */
  it('不修改入参数组', () => {
    const orig = [w('他', 100)]
    shiftWords(orig, 5000)
    expect(orig).toEqual([w('他', 100)])
  })

  it('文字与标点标记原样保留', () => {
    const src: WordTiming[] = [{ text: '。', offsetMs: 0, durationMs: 100, isPunctuation: true }]
    expect(shiftWords(src, 1000)).toEqual([
      { text: '。', offsetMs: 1000, durationMs: 100, isPunctuation: true },
    ])
  })
})

describe('synthesizeLong', () => {
  it('长文案：偏移量用实测时长，且累积正确', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lt2-'))
    try {
      const calls: string[] = []
      // 假 synthesize：每段都产出「段内从 0 开始」的时间轴
      const fakeSynth = async (o: any) => {
        calls.push(o.text)
        await silence(o.outPath, 1)
        return {
          audioPath: o.outPath,
          words: [
            { text: '首', offsetMs: 0, durationMs: 200, isPunctuation: false },
            { text: '末', offsetMs: 1000, durationMs: 200, isPunctuation: false },
          ],
          durationMs: 1200,
        }
      }
      // 假 probe：每段【真实】时长 5000ms —— 注意它比「末词结束时间 1200ms」大得多，
      // 正是尾音静音。用错取法的实现会在这里露馅。
      const fakeProbe = async () => 5000

      const long = '他决定去买包子。'.repeat(400)
      const r = await synthesizeLong(
        { text: long, outPath: join(dir, 'out.mp3'), key: 'k', region: 'r' },
        { synthesize: fakeSynth as any, probe: fakeProbe as any }
      )

      expect(r.segmentCount).toBeGreaterThanOrEqual(2)
      expect(calls.length).toBe(r.segmentCount)          // 每段各合成一次
      // 切段不丢字：各段拼回去等于原文
      expect(calls.join('')).toBe(long)

      const offsets = r.words.map((w) => w.offsetMs)

      // 段 1 的词不平移
      expect(offsets.slice(0, 2)).toEqual([0, 1000])

      /*
       * 【这条是整个计划的核心断言】
       * 段 2 的词整体 +5000（probe 量出的实测时长），而不是 +1200（末词结束时间）。
       * 若这里得到 [1200, 2200]，说明实现用了「最后一个词的 offsetMs + durationMs」，
       * 漏掉了尾音静音——而这个误差会逐段累积，成片越到后面字幕偏得越离谱。
       */
      expect(offsets.slice(2, 4)).toEqual([5000, 6000])

      // 时间轴必须单调不减——这是字幕分行的前提
      // （noUncheckedIndexedAccess：不逐个索引取值，整体与自身的排序副本比对）
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b))

      // 返回的音频就是调用方要的那一条，且总时长走 probe 实测
      expect(r.audioPath).toBe(join(dir, 'out.mp3'))
      expect(r.durationMs).toBe(5000)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('三段以上时误差不累积', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lt3-'))
    try {
      // 每段实测 5000ms，第 3 段的偏移必须是 10000 而非 2×1200
      const fakeSynth = async (o: any) => {
        await silence(o.outPath, 1)
        return {
          audioPath: o.outPath, durationMs: 1200,
          words: [{ text: '首', offsetMs: 0, durationMs: 200, isPunctuation: false }],
        }
      }
      const r = await synthesizeLong(
        { text: '他决定去买包子。'.repeat(900), outPath: join(dir, 'out.mp3'), key: 'k', region: 'r' },
        { synthesize: fakeSynth as any, probe: (async () => 5000) as any }
      )
      expect(r.segmentCount).toBeGreaterThanOrEqual(3)
      expect(r.words.map((w) => w.offsetMs).slice(0, 3)).toEqual([0, 5000, 10000])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('短文案：单段直通，不触发拼接', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lt1-'))
    try {
      const outPath = join(dir, 'out.mp3')
      let probeCalls = 0
      const fakeSynth = async (o: any) => {
        await silence(o.outPath, 1)
        return {
          audioPath: o.outPath,
          words: [{ text: '他', offsetMs: 0, durationMs: 200, isPunctuation: false }],
          durationMs: 200,
        }
      }
      const r = await synthesizeLong(
        { text: '他决定去买包子。', outPath, key: 'k', region: 'r' },
        { synthesize: fakeSynth as any, probe: (async () => { probeCalls++; return 200 }) as any }
      )
      expect(r.segmentCount).toBe(1)
      expect(r.words.map((x) => x.offsetMs)).toEqual([0])   // 不用 r.words[0]，见 shiftWords 的说明
      // 直通路径：synthesize 的返回值原样透出，不重新探测、不拼接
      expect(r.durationMs).toBe(200)
      expect(probeCalls).toBe(0)
      // 直通就该直接写到 outPath，不产生任何中间文件
      expect(await readdir(dir)).toEqual(['out.mp3'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('分段文件用完即清，不留残渣', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ltc-'))
    try {
      const fakeSynth = async (o: any) => {
        await silence(o.outPath, 1)
        return {
          audioPath: o.outPath, durationMs: 1200,
          words: [{ text: '首', offsetMs: 0, durationMs: 200, isPunctuation: false }],
        }
      }
      const r = await synthesizeLong(
        { text: '他决定去买包子。'.repeat(400), outPath: join(dir, 'out.mp3'), key: 'k', region: 'r' },
        { synthesize: fakeSynth as any, probe: (async () => 5000) as any }
      )
      expect(r.segmentCount).toBeGreaterThanOrEqual(2)
      expect(await readdir(dir)).toEqual(['out.mp3'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  /*
   * 失败路径也要清干净。中途报错时若不清理，用户的素材目录里会留下
   * 一堆 *.partN.mp3 —— 而那个目录是要展示给用户看的。
   */
  it('中途合成失败时，已产出的分段文件也要清掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ltf-'))
    try {
      let n = 0
      const fakeSynth = async (o: any) => {
        if (n++ >= 1) throw new Error('配音失败：模拟第二段挂掉')
        await silence(o.outPath, 1)
        return {
          audioPath: o.outPath, durationMs: 1200,
          words: [{ text: '首', offsetMs: 0, durationMs: 200, isPunctuation: false }],
        }
      }
      await expect(synthesizeLong(
        { text: '他决定去买包子。'.repeat(400), outPath: join(dir, 'out.mp3'), key: 'k', region: 'r' },
        { synthesize: fakeSynth as any, probe: (async () => 5000) as any }
      )).rejects.toThrow(/模拟第二段挂掉/)
      expect(await readdir(dir)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
