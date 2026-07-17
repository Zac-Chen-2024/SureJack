import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { unescapeXml } from '../importers/sanitize.js'
import type { WordTiming, TtsResult } from '../types.js'

/** F0 免费层单次请求的音频上限是 10 分钟 */
const MAX_AUDIO_MS = 10 * 60 * 1000

/** 实测：937 字 → 184.2 秒，约 196 ms/字。用于提交前拦截，不求精确。 */
export function estimateAudioMs (charCount: number): number {
  return charCount * 196
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
  rate?: number
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
  if (est > MAX_AUDIO_MS) {
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

    synth.speakTextAsync(opts.text, (result) => {
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
    }, (err) => { synth.close(); reject(new Error(`配音出错：${err}`)) })
  })
}
