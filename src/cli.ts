#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { assertFontAvailable, ASPECT_PRESETS } from './config.js'
import { importScript } from './importers/index.js'
import { synthesize } from './tts/index.js'
import { segmentLines, buildAss } from './subtitles/index.js'
import { render } from './render/index.js'
import type { TextOverlay } from './types.js'

loadEnv()

const { values } = parseArgs({
  options: {
    script: { type: 'string' },
    video: { type: 'string' },
    bgm: { type: 'string' },
    out: { type: 'string' },
    title: { type: 'string' },
    aspect: { type: 'string', default: '9:16' },
    mode: { type: 'string', default: 'karaoke' },
  },
})

if (!values.script || !values.video || !values.out) {
  console.error(`用法：npm run cli -- --script <文案> --video <背景视频> --out <成片.mp4>
  可选：--bgm <音乐> --title <标题> --aspect 9:16|4:5|1:1|16:9 --mode karaoke|line`)
  process.exit(1)
}

const key = process.env.AZURE_SPEECH_KEY
const region = process.env.AZURE_SPEECH_REGION
if (!key || !region) {
  console.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，参考 .env.example')
  process.exit(1)
}

const aspect = ASPECT_PRESETS[values.aspect!]
if (!aspect) {
  console.error(`未知画幅：${values.aspect}。支持 ${Object.keys(ASPECT_PRESETS).join(' / ')}`)
  process.exit(1)
}

// 字体是静默失败的——必须主动探测，不能等到成片出来才发现字幕是方块
assertFontAvailable()

console.log('→ 读文案')
const text = await importScript(values.script)
console.log(`  ${text.length} 字`)

console.log('→ 配音（整篇一次合成）')
const tts = await synthesize({ text, outPath: '/tmp/sj-voice.mp3', key, region })
console.log(`  ${(tts.durationMs / 1000).toFixed(1)} 秒，${tts.words.length} 个词级事件`)

console.log('→ 断句并生成 ASS')
const lines = segmentLines(tts.words, 14)
const overlays: TextOverlay[] = [
  { content: '小说内容纯属虚构，无不良引导', style: 'Disclaimer', startMs: null, endMs: null },
]
if (values.title) {
  overlays.push({ content: values.title, style: 'Title', startMs: null, endMs: null })
}
const ass = buildAss({
  lines, overlays, aspect, durationMs: tts.durationMs,
  mode: values.mode === 'line' ? 'line' : 'karaoke',
})
writeFileSync('/tmp/sj-sub.ass', ass)
console.log(`  ${lines.length} 行字幕`)

console.log('→ 合成')
await render({
  clips: [{ path: values.video, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
  voicePath: tts.audioPath,
  bgmPath: values.bgm,
  bgmVolume: 0.1,
  assPath: '/tmp/sj-sub.ass',
  aspect,
  durationMs: tts.durationMs,
  outPath: values.out,
}, (pct) => process.stdout.write(`\r  ${pct.toFixed(0)}%`))

console.log(`\n✅ ${values.out}`)
