/**
 * 端到端 demo 的第一步：把文案转成配音 + 词级时间戳。
 *
 * 这不是生产代码，是 Example/ 那条 demo 的一次性脚本。
 * 但它的逻辑就是 tts/ 模块将来要做的事。
 */
import { config as loadEnv } from 'dotenv'
import { writeFileSync, readFileSync } from 'node:fs'
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'

loadEnv({ path: new URL('../azure-tts/.env', import.meta.url).pathname })

const SCRIPT = '/root/SureJack/Example/test.txt'
const OUT_AUDIO = '/root/SureJack/spikes/demo/voice.mp3'
const OUT_TIMINGS = '/root/SureJack/spikes/demo/timings.json'

const raw = readFileSync(SCRIPT, 'utf-8')
// 段落之间的空行会让 TTS 停顿过长；压成单空格，保留标点做断句
const text = raw.replace(/\s+/g, ' ').trim()

console.log(`文案 ${text.length} 字`)
if (text.length > 8000) {
  console.error('❌ 文案过长，F0 单次请求上限约 10 分钟音频')
  process.exit(1)
}

const config = sdk.SpeechConfig.fromSubscription(
  process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION
)
config.speechSynthesisVoiceName = 'zh-CN-XiaoxiaoNeural'
config.speechSynthesisOutputFormat =
  sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3

const synth = new sdk.SpeechSynthesizer(config, sdk.AudioConfig.fromAudioFileOutput(OUT_AUDIO))

const events = []
synth.wordBoundary = (_s, e) => {
  events.push({
    text: e.text,
    offsetMs: e.audioOffset / 10000,   // HNS → ms
    durationMs: e.duration / 10000,
    boundaryType: String(e.boundaryType),
  })
}

console.log('合成中…')
synth.speakTextAsync(text, (result) => {
  if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
    console.error('❌ 失败：', result.errorDetails)
    synth.close(); process.exit(1)
  }
  const ms = result.audioDuration / 10000
  console.log(`✅ 音频 ${(ms / 1000).toFixed(1)} 秒，${events.length} 个事件`)
  writeFileSync(OUT_TIMINGS, JSON.stringify({ durationMs: ms, events }, null, 2))
  synth.close()
}, (err) => {
  console.error('❌ 出错：', err)
  synth.close(); process.exit(1)
})
