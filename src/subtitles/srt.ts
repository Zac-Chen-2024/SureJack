import type { SubtitleLine } from '../types.js'

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/

function toMs (h: string, m: string, s: string, ms: string): number {
  return ((parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000) + parseInt(ms, 10)
}

/**
 * 解析整句 SRT 字幕，产出 SubtitleLine[]。
 *
 * SRT 是句级时间戳，没有词级时间——每条 cue 的正文整体塞进一个
 * "词"里（words 数组长度恒为 1），这样 buildAss 的 line 模式
 * （逐词 escapeAssText 后拼接）能原样渲染整句，同时不需要改
 * SubtitleLine/WordTiming 的类型定义。
 *
 * 绝不能再对结果跑 segmentLines——SRT 已经是用户/剪辑软件断好的句子，
 * 重新断句会破坏原有分行。
 */
export function parseSrt (text: string): SubtitleLine[] {
  // 剥 UTF-8 BOM：不剥会污染第一条 cue 的序号行，进而匹配不到时间码
  const stripped = text.replace(/^﻿/, '')
  // 统一行尾：Windows 存的 SRT 常带 \r，split 前先归一化
  const normalized = stripped.replace(/\r\n|\r/g, '\n')

  const blocks = normalized.split(/\n\n+/)
  const lines: SubtitleLine[] = []

  for (const block of blocks) {
    const trimmedBlock = block.trim()
    if (!trimmedBlock) continue

    const blockLines = trimmedBlock.split('\n')
    const timeLineIdx = blockLines.findIndex((l) => TIME_RE.test(l))
    if (timeLineIdx === -1) continue // 没有时间码行，不是合法 cue，跳过

    const match = blockLines[timeLineIdx]!.match(TIME_RE)!
    const startMs = toMs(match[1]!, match[2]!, match[3]!, match[4]!)
    const endMs = toMs(match[5]!, match[6]!, match[7]!, match[8]!)

    // 时间码行之后的所有行都是正文——多行正文用真实换行连接，
    // escapeAssText 会在 buildAss 阶段把 \n 转成 ASS 的 \N
    const content = blockLines.slice(timeLineIdx + 1).join('\n').trim()
    if (!content) continue // 空文本 cue（有时间码没正文）丢弃

    lines.push({
      startMs,
      endMs,
      words: [{ text: content, offsetMs: startMs, durationMs: endMs - startMs, isPunctuation: false }],
    })
  }

  return lines
}
