import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { unescapeXml } from '../importers/sanitize.js'
import type { WordTiming, TtsResult } from '../types.js'

/** F0 免费层单次请求的音频上限是 10 分钟 */
const MAX_AUDIO_MS = 10 * 60 * 1000

/**
 * 拦截判断的保守系数。
 *
 * estimateAudioMs 只基于单一实测样本（单一音色、单一语速、纯中文），
 * 而且连那一个样本都低估了：937 字 × 196ms = 183,652ms，实测却是
 * 184,200ms。语速、停顿、标点密度都会让 196 这个系数继续波动。
 *
 * 这个估算的唯一用途是【提交前拦截超过 10 分钟的文案】，而高估和低估
 * 的代价完全不对等：
 *   - 高估 → 错误拒绝了本可用的文案，用户体验差，但零成本。
 *   - 低估 → 放行了实际会超时的文案，打到 Azure 才失败，白白烧掉一次
 *     限速 20 次/60 秒 的请求，且失败发生在流程末端，排查成本高。
 *
 * 所以拦截判断宁可错杀，不可放过：估算值再乘一个保守系数。
 */
const REJECTION_SAFETY_MARGIN = 1.15

/**
 * 实测：937 字 → 184.2 秒，约 196 ms/字。
 *
 * 导出这个常量是为了让反向换算（给定毫秒预算能放几个字）也走同一个来源。
 * 曾经 split.ts 里另抄了一份 196，改这里就会静默漂移。
 */
export const MS_PER_CHAR = 196

/** 由字数估算音频时长。用于切段与提交前校验，不求精确。 */
export function estimateAudioMs (charCount: number): number {
  return charCount * MS_PER_CHAR
}

/** estimateAudioMs 的反函数：给定毫秒预算，最多能放几个字。 */
export function maxCharsForMs (ms: number): number {
  return Math.floor(ms / MS_PER_CHAR)
}

/**
 * 把 Azure 的 WordBoundary 事件归一化成我们的结构。
 *
 * 两个坑（都已实测）：
 *   1. audioOffset 单位是 100 纳秒（HNS），除以 10000 才是毫秒
 *   2. text 是【XML 转义后】的形态——& 回来是 &amp;，必须反转义，
 *      否则字幕会字面显示实体码
 *
 * 【不要用 textOffset】：它指向 SSML 字符串位置而非原文，
 * 转义会让偏移错位。只用 text。
 */
export function toWordTiming (e: {
  text: string; audioOffset: number; duration: number; boundaryType: string
}): WordTiming {
  return {
    text: unescapeXml(e.text),
    offsetMs: e.audioOffset / 10000,
    durationMs: e.duration / 10000,
    isPunctuation: e.boundaryType.toLowerCase().includes('punct'),
  }
}

export interface SynthesizeOptions {
  text: string
  outPath: string
  voice?: string
  key: string
  region: string
}

/**
 * 整篇一次合成，绝不逐句请求。
 *
 * F0 限速是【每 60 秒 20 次请求】——一篇 30 句的文案逐句合成
 * 就是 30 次请求，直接撞墙。单次最长可出 10 分钟音频，够用。
 *
 * 这是可替换接口：换 TTS 服务商只动这个模块。
 */
export function synthesize (opts: SynthesizeOptions): Promise<TtsResult> {
  const est = estimateAudioMs(opts.text.length)
  if (est * REJECTION_SAFETY_MARGIN > MAX_AUDIO_MS) {
    throw new Error(
      `文案太长（约 ${Math.round(est / 60000)} 分钟音频），` +
      `超过免费层单次 10 分钟的上限。请拆成多个项目。`
    )
  }

  return new Promise((resolve, reject) => {
    const config = sdk.SpeechConfig.fromSubscription(opts.key, opts.region)
    config.speechSynthesisVoiceName = opts.voice ?? 'zh-CN-XiaoxiaoNeural'
    config.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3

    const synth = new sdk.SpeechSynthesizer(
      config, sdk.AudioConfig.fromAudioFileOutput(opts.outPath))

    const words: WordTiming[] = []
    synth.wordBoundary = (_s, e) => {
      words.push(toWordTiming({
        text: e.text, audioOffset: e.audioOffset,
        duration: e.duration, boundaryType: String(e.boundaryType),
      }))
    }

    // 兜底：底层 WebSocket 若因网络分区或服务端挂起而从不触发任何回调，
    // Promise 会永远不 settle，synth.close() 也永远不会被调用——连接
    // 一直挂着，上层拿不到任何信号。超时后主动关闭并 reject。
    // 时长给足 5 分钟：合成接近 10 分钟音频本身就需要时间。
    const timeoutMs = 5 * 60 * 1000
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      synth.close()
      reject(new Error(`配音超时：${Math.round(timeoutMs / 60000)} 分钟内未收到 Azure 响应`))
    }, timeoutMs)

    synth.speakTextAsync(opts.text, (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      synth.close()
      if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
        // 配额耗尽和限流都会走到这里，把原始信息带出去让上层能区分
        reject(new Error(`配音失败：${result.errorDetails}`))
        return
      }
      resolve({
        audioPath: opts.outPath,
        durationMs: result.audioDuration / 10000,
        words,
      })
    }, (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      synth.close()
      reject(new Error(`配音出错：${err}`))
    })
  })
}
