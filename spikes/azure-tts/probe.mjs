/**
 * 验证 Azure zh-CN 的字级时间戳形态。
 *
 * 要回答四个问题，每个都直接决定 subtitles/ 模块怎么写：
 *   1. 标点是否单独触发事件？（断句逻辑完全依赖这一点）
 *   2. 中文怎么切词——逐字还是成词？（决定卡拉OK \kf 的粒度）
 *   3. 数字（99%）和英文（AI）的边界行为？
 *   4. 时间戳是否单调递增、有无重叠？（断句算法的基本假设）
 */
import { config as loadEnv } from 'dotenv'
import { writeFileSync } from 'node:fs'
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'

// 显式指定路径：脚本从仓库根目录运行，但 .env 在脚本自己的目录里
loadEnv({ path: new URL('./.env', import.meta.url).pathname })

// 故意包含标点、数字、百分号、英文缩写——都是营销号文案里的常客
const TEXT = '震惊！这个方法99%的人都不知道，AI一秒搞定，你还在等什么？'

const key = process.env.AZURE_SPEECH_KEY
const region = process.env.AZURE_SPEECH_REGION
if (!key || !region) {
  console.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，请先建 .env')
  process.exit(1)
}

const config = sdk.SpeechConfig.fromSubscription(key, region)
config.speechSynthesisVoiceName = 'zh-CN-XiaoxiaoNeural'
config.speechSynthesisOutputFormat =
  sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3

const audio = sdk.AudioConfig.fromAudioFileOutput('spikes/azure-tts/out.mp3')
const synth = new sdk.SpeechSynthesizer(config, audio)

const events = []
synth.wordBoundary = (_s, e) => {
  events.push({
    text: e.text,
    // audioOffset 单位是 100 纳秒（HNS），除以 10000 得毫秒
    offsetMs: e.audioOffset / 10000,
    durationMs: e.duration / 10000,
    textOffset: e.textOffset,
    wordLength: e.wordLength,
    boundaryType: String(e.boundaryType),
  })
}

console.log(`合成中（${region} / zh-CN-XiaoxiaoNeural）：「${TEXT}」\n`)

synth.speakTextAsync(
  TEXT,
  (result) => {
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      console.error('❌ 合成失败：', result.errorDetails)
      synth.close()
      process.exit(1)
    }

    console.log(`音频总时长：${(result.audioDuration / 10000).toFixed(0)} ms`)
    console.log(`WordBoundary 事件数：${events.length}\n`)

    console.log('序号  类型          起始(ms)  时长(ms)  文本')
    console.log('─'.repeat(58))
    for (const [i, e] of events.entries()) {
      console.log(
        `${String(i).padStart(3)}  ${e.boundaryType.padEnd(12)}  ` +
        `${String(Math.round(e.offsetMs)).padStart(8)}  ` +
        `${String(Math.round(e.durationMs)).padStart(8)}  ${e.text}`
      )
    }

    // 问题 1：标点是否单独触发
    const punct = events.filter((e) => e.boundaryType.toLowerCase().includes('punct'))
    console.log(`\n【1】标点类事件：${punct.length} 个 → ${punct.map((p) => p.text).join(' ')}`)
    console.log(punct.length > 0
      ? '    ✅ 标点单独触发——断句可直接用它，不需要自己分词'
      : '    ❌ 无标点事件——断句必须自己实现中文分词，设计文档第 7 节要改')

    // 问题 2：切词粒度
    const words = events.filter((e) => e.boundaryType.toLowerCase().includes('word'))
    const multi = words.filter((w) => [...w.text].length > 1)
    console.log(`\n【2】Word 事件 ${words.length} 个，其中多字词 ${multi.length} 个`)
    console.log(`    样例：${words.slice(0, 8).map((w) => w.text).join(' / ')}`)
    console.log(multi.length > 0
      ? '    → 成词切分（Azure 自己做了中文分词）'
      : '    → 逐字切分')

    // 问题 3：数字与英文
    const special = events.filter((e) => /[0-9A-Za-z%]/.test(e.text))
    console.log(`\n【3】含数字/英文的事件：${special.map((s) => `「${s.text}」`).join(' ') || '（无）'}`)

    // 问题 4：单调性与重叠
    let monotonic = true, overlap = 0
    for (let i = 1; i < events.length; i++) {
      if (events[i].offsetMs < events[i - 1].offsetMs) monotonic = false
      if (events[i].offsetMs < events[i - 1].offsetMs + events[i - 1].durationMs) overlap++
    }
    console.log(`\n【4】时间戳单调递增：${monotonic ? '✅ 是' : '❌ 否'}　重叠事件：${overlap} 个`)
    console.log(`    覆盖率：末事件结束于 ${Math.round(events.at(-1).offsetMs + events.at(-1).durationMs)} ms，` +
      `音频总长 ${(result.audioDuration / 10000).toFixed(0)} ms`)

    writeFileSync('spikes/azure-tts/timings.json', JSON.stringify(events, null, 2))
    console.log('\n完整时间戳已写入 spikes/azure-tts/timings.json')
    synth.close()
  },
  (err) => {
    console.error('❌ 出错：', err)
    synth.close()
    process.exit(1)
  }
)
