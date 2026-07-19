import { join, dirname, basename } from 'node:path'
import { unlink } from 'node:fs/promises'
import { synthesize, type SynthesizeOptions } from './azure.js'
import { splitScript } from './split.js'
import { concatAudio } from './concat.js'
import { probeDurationMs } from '../render/probe.js'
import type { WordTiming, TtsResult } from '../types.js'

/**
 * 把一段的词时间轴整体平移 offsetMs。
 *
 * 【只动 offsetMs】：durationMs 是这个词自身念了多久，与它在总时间轴上
 * 的位置无关，平移时绝不能动。
 *
 * 返回新数组，不就地修改——调用方可能还要用原始的段内时间轴排查问题。
 */
export function shiftWords (words: WordTiming[], offsetMs: number): WordTiming[] {
  return words.map((w) => ({ ...w, offsetMs: w.offsetMs + offsetMs }))
}

export interface LongTtsResult extends TtsResult {
  /** 实际分了几段。1 表示没有分段，走的是直通路径。 */
  segmentCount: number
}

/**
 * 段间额外停顿，单位毫秒。
 *
 * 目前是 0：Azure 每段结尾自带一小段尾音静音，实测已经足够像一次换气，
 * 再补就成了突兀的空白。留这个常量是为了让「要不要补停顿」有个明确的
 * 调节点——若真要调，记得它必须【同时】计入时间轴偏移和拼接后的音频，
 * 只改一处会让后面所有字幕整体错位。
 */
const SEGMENT_GAP_MS = 0

/**
 * 长文案合成：自动切段 → 逐段合成 → 平移时间轴 → 拼接成一条音频。
 *
 * 短文案（不需要切）会直通到 synthesize，不产生任何中间文件，
 * 行为与未引入分段前完全一致。
 *
 * deps 仅供测试注入假实现，生产调用不要传——注入假的 synthesize
 * 就能在不打 Azure、不烧配额的前提下测完整的分段与平移逻辑。
 */
export async function synthesizeLong (
  opts: SynthesizeOptions,
  deps: { synthesize?: typeof synthesize; probe?: typeof probeDurationMs } = {}
): Promise<LongTtsResult> {
  const synth = deps.synthesize ?? synthesize
  const probe = deps.probe ?? probeDurationMs

  const chunks = splitScript(opts.text)

  // 直通：不切段就不碰拼接，少一层出错的可能
  if (chunks.length === 1) {
    const r = await synth(opts)
    return { ...r, segmentCount: 1 }
  }

  const dir = dirname(opts.outPath)
  const stem = basename(opts.outPath, '.mp3')
  const parts: string[] = []
  const words: WordTiming[] = []
  let offsetMs = 0

  try {
    // 用 entries() 而不是下标取值：tsconfig 开了 noUncheckedIndexedAccess，
    // chunks[i] 的类型是 string | undefined，过不了 tsc。
    for (const [i, chunk] of chunks.entries()) {
      const partPath = join(dir, `${stem}.part${i}.mp3`)
      // 先登记再合成：synth 抛错时文件可能已经落盘了一半，
      // 没登记的话 finally 里就漏清这一个。
      parts.push(partPath)
      const r = await synth({ ...opts, text: chunk, outPath: partPath })

      words.push(...shiftWords(r.words, offsetMs))

      // 【关键】偏移量取【实测文件时长】，不是估算、也不是末词结束时间。
      // 末词念完后还有尾音静音，用末词时间会让每段少算一截，
      // 而误差是累积的——段数越多，后面的字幕偏得越离谱。
      offsetMs += await probe(partPath) + SEGMENT_GAP_MS
    }

    await concatAudio(parts, opts.outPath)

    return {
      audioPath: opts.outPath,
      words,
      // 总时长同样实测：各段之和会漏掉拼接重编码带来的帧对齐零头
      durationMs: await probe(opts.outPath),
      segmentCount: chunks.length,
    }
  } finally {
    // 分段文件是中间产物，无论成败都清掉，别在用户的素材目录里留垃圾
    await Promise.all(parts.map((p) => unlink(p).catch(() => {})))
  }
}
