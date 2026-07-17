#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { assertFontAvailable, ASPECT_PRESETS } from './config.js'
import { importScript } from './importers/index.js'
import { synthesize } from './tts/index.js'
import { segmentLines, buildAss, parseSrt } from './subtitles/index.js'
import { render, probeDurationMs } from './render/index.js'
import type { TextOverlay } from './types.js'

loadEnv()

const USAGE = `用法（二选一）：
  路径 A（文案 → Azure TTS）：
    npm run cli -- --script <文案> --video <背景视频> --out <成片.mp4>
  路径 B（自带配音 + 整句 SRT，跳过 TTS）：
    npm run cli -- --audio <配音.mp3> --srt <字幕.srt> --video <背景视频> --out <成片.mp4>
  两条路公共可选：--bgm <音乐> --title <标题> --aspect 9:16|4:5|1:1|16:9
  路径 A 额外可选：--mode karaoke|line（默认 karaoke）。路径 B 强制整句字幕，不接受 --mode。`

async function main () {
  const { values } = parseArgs({
    options: {
      script: { type: 'string' },
      audio: { type: 'string' },
      srt: { type: 'string' },
      video: { type: 'string' },
      bgm: { type: 'string' },
      out: { type: 'string' },
      title: { type: 'string' },
      aspect: { type: 'string', default: '9:16' },
      mode: { type: 'string' },
    },
  })

  const hasScript = values.script !== undefined
  const hasAudio = values.audio !== undefined
  const hasSrt = values.srt !== undefined

  if (hasScript && (hasAudio || hasSrt)) {
    console.error(`--script 和 --audio/--srt 互斥：给文案走 TTS 合成，给配音+字幕走自带路径，不能同时给。\n\n${USAGE}`)
    process.exit(1)
  }
  if (!hasScript && !hasAudio && !hasSrt) {
    console.error(USAGE)
    process.exit(1)
  }
  if (hasAudio !== hasSrt) {
    console.error(`--audio 和 --srt 必须同时提供，缺一个都不行。\n\n${USAGE}`)
    process.exit(1)
  }
  if (!values.video || !values.out) {
    console.error(USAGE)
    process.exit(1)
  }

  const aspect = ASPECT_PRESETS[values.aspect!]
  if (!aspect) {
    console.error(`未知画幅：${values.aspect}。支持 ${Object.keys(ASPECT_PRESETS).join(' / ')}`)
    process.exit(1)
  }

  // 字体是静默失败的——必须主动探测，不能等到成片出来才发现字幕是方块
  assertFontAvailable()

  const overlays: TextOverlay[] = [
    { content: '小说内容纯属虚构，无不良引导', style: 'Disclaimer', startMs: null, endMs: null },
  ]
  if (values.title) {
    overlays.push({ content: values.title, style: 'Title', startMs: null, endMs: null })
  }

  if (hasScript) {
    // ── 路径 A：文案 → Azure TTS → 词级时间戳 → karaoke/line ──
    const mode = values.mode ?? 'karaoke'
    if (mode !== 'line' && mode !== 'karaoke') {
      throw new Error(`未知模式：${mode}。支持 line / karaoke`)
    }

    const key = process.env.AZURE_SPEECH_KEY
    const region = process.env.AZURE_SPEECH_REGION
    if (!key || !region) {
      console.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，参考 .env.example')
      process.exit(1)
    }

    // 早失败：在任何昂贵操作之前检查文件存在性
    if (!existsSync(values.script!)) {
      throw new Error(`文案文件不存在：${values.script}`)
    }
    if (!existsSync(values.video)) {
      throw new Error(`背景视频不存在：${values.video}`)
    }
    if (values.bgm && !existsSync(values.bgm)) {
      throw new Error(`背景音乐不存在：${values.bgm}`)
    }

    console.log('→ 读文案')
    const text = await importScript(values.script!)
    console.log(`  ${text.length} 字`)

    console.log('→ 配音（整篇一次合成）')
    const tts = await synthesize({ text, outPath: '/tmp/sj-voice.mp3', key, region })
    console.log(`  ${(tts.durationMs / 1000).toFixed(1)} 秒，${tts.words.length} 个词级事件`)

    console.log('→ 断句并生成 ASS')
    const lines = segmentLines(tts.words, 14)
    const ass = buildAss({ lines, overlays, aspect, durationMs: tts.durationMs, mode })
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
    return
  }

  // ── 路径 B：自带配音 mp3 + 整句 SRT，跳过 TTS，强制 line 模式 ──
  if (values.mode !== undefined && values.mode !== 'line') {
    console.log(`ℹ️  自带 SRT 只支持整句字幕，已忽略 --mode ${values.mode}，强制使用 line 模式`)
  }

  // 早失败：在任何昂贵操作之前检查文件存在性
  if (!existsSync(values.audio!)) {
    throw new Error(`配音文件不存在：${values.audio}`)
  }
  if (!existsSync(values.srt!)) {
    throw new Error(`字幕文件不存在：${values.srt}`)
  }
  if (!existsSync(values.video)) {
    throw new Error(`背景视频不存在：${values.video}`)
  }
  if (values.bgm && !existsSync(values.bgm)) {
    throw new Error(`背景音乐不存在：${values.bgm}`)
  }

  console.log('→ 解析 SRT')
  const srtText = readFileSync(values.srt!, 'utf-8')
  const lines = parseSrt(srtText)
  console.log(`  ${lines.length} 条字幕`)

  console.log('→ 探测配音时长')
  const durationMs = await probeDurationMs(values.audio!)
  console.log(`  ${(durationMs / 1000).toFixed(1)} 秒`)

  console.log('→ 生成 ASS')
  const ass = buildAss({ lines, overlays, aspect, durationMs, mode: 'line' })
  writeFileSync('/tmp/sj-sub.ass', ass)

  console.log('→ 合成')
  await render({
    clips: [{ path: values.video, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
    voicePath: values.audio!,
    bgmPath: values.bgm,
    bgmVolume: 0.1,
    assPath: '/tmp/sj-sub.ass',
    aspect,
    durationMs,
    outPath: values.out,
  }, (pct) => process.stdout.write(`\r  ${pct.toFixed(0)}%`))

  console.log(`\n✅ ${values.out}`)
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
