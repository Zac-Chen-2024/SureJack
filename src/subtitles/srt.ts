import type { SubtitleLine } from '../types.js'
import { stripBom } from '../importers/sanitize.js'

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
// 序号行：整行只有数字（catdoc/剪辑软件产出的裸序号），用来在缺空行时
// 识别"下一条 cue 的开头"，见下方 parseSrt 的行扫描逻辑。
const SEQ_RE = /^\d+$/

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
 *
 * ⚠️ 解析方式是逐行扫描找时间码行，而不是先按空行切块（`split(/\n\n+/)`）。
 * 原先按空行切块的实现有一个隐患：真实世界的 SRT 文件不总是严格遵守
 * "cue 之间必须有空行"的规范——如果两条 cue 之间缺了空行，它们会被
 * 分进同一个 block，而 block 内只找第一个时间码行，导致【第二条 cue 的
 * 序号/时间码/正文全部被当成第一条 cue 的正文】烧进字幕——这不是解析
 * 失败，是解析"成功"但内容错误，观众会在画面上看到裸露的序号和时间码。
 *
 * 逐行扫描能在同一遍里同时处理两种输入：
 *   - 正常场景：cue 之间有空行 → 空行天然终止上一条 cue 的正文收集。
 *   - 缺空行场景：正文收集到一半，遇到"纯数字行 + 紧跟着的时间码行"
 *     这个强信号，就判定是下一条 cue 的序号+时间码开始了，立即停止
 *     收集正文，绝不把它们并入当前 cue。
 * 之所以选"按内部时间码重新切分"而不是直接报错：用户的 SRT 少一个
 * 空行是常见的、无害的格式瑕疵（很多剪辑软件导出就不带空行），不应该
 * 让整个文件解析失败；只要不把时间码/序号当正文塞进去，就已经消除了
 * 观众会看到的错误内容。
 */
export function parseSrt (text: string): SubtitleLine[] {
  // 剥 UTF-8 BOM：不剥会污染第一条 cue 的序号行，进而匹配不到时间码
  const stripped = stripBom(text)
  // 统一行尾：Windows 存的 SRT 常带 \r，按行处理前先归一化
  const normalized = stripped.replace(/\r\n|\r/g, '\n')

  const rawLines = normalized.split('\n')
  const lines: SubtitleLine[] = []

  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]!
    if (!TIME_RE.test(line)) {
      // 空行、序号行、BOM 残留等噪声行，跳过继续找下一个时间码行
      i++
      continue
    }

    const match = line.match(TIME_RE)!
    const startMs = toMs(match[1]!, match[2]!, match[3]!, match[4]!)
    const endMs = toMs(match[5]!, match[6]!, match[7]!, match[8]!)

    // 从时间码行之后开始收集正文，直到：空行 / 另一个时间码行（无序号
    // 直接粘连的极端情况）/ "纯数字行 + 下一行是时间码"（有序号但缺
    // 空行的粘连情况）——三种情况都意味着当前 cue 到此结束
    const content: string[] = []
    let j = i + 1
    while (j < rawLines.length) {
      const l = rawLines[j]!
      if (!l.trim()) break
      if (TIME_RE.test(l)) break
      if (SEQ_RE.test(l.trim()) && j + 1 < rawLines.length && TIME_RE.test(rawLines[j + 1]!)) break
      content.push(l)
      j++
    }

    const text = content.join('\n').trim()
    if (text) {
      // 多行正文用真实换行连接，escapeAssText 会在 buildAss 阶段
      // 把 \n 转成 ASS 的 \N
      lines.push({
        startMs,
        endMs,
        words: [{ text, offsetMs: startMs, durationMs: endMs - startMs, isPunctuation: false }],
      })
    } // 空文本 cue（有时间码没正文）丢弃

    i = j
  }

  return lines
}
