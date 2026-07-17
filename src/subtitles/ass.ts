import { FONT_FAMILY } from '../config.js'
import type { SubtitleLine, TextOverlay, AspectPreset } from '../types.js'

export interface BuildAssOptions {
  lines: SubtitleLine[]
  overlays: TextOverlay[]
  aspect: AspectPreset
  durationMs: number
  mode: 'line' | 'karaoke'
}

/**
 * 毫秒 → ASS 时间码 H:MM:SS.cc
 *
 * ⚠️ 必须先把毫秒舍入到整数厘秒（ASS 的时间精度），再用整数除法/取余
 * 逐级算出 h/m/s/cs。不能先算未舍入的 h/m，再对秒数单独 toFixed(2)——
 * 那样秒的四舍五入进位（如 59.999 → "60.00"）不会级联回分钟/小时，
 * 产出 "0:00:60.00" 这种非法时间码。全程整数运算，从根上避免这个问题。
 */
export function formatAssTime (ms: number): string {
  const totalCs = Math.round(Math.max(0, ms) / 10)
  const h = Math.floor(totalCs / 360000)
  const m = Math.floor((totalCs % 360000) / 6000)
  const s = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * 转义 ASS 纯文本，防止用户可编辑文案（标题、免责声明、字幕词）
 * 被当成 ASS 语法解析。
 *
 * ⚠️ 只能用于用户文本。我们自己生成的样式标签（如 buildKaraoke 产出的
 * `{\kf50}`）绝不能经过这个函数——那会把我们自己的合法标签也转义掉。
 *
 * 顺序很重要：反斜杠必须最先替换，否则会把后面替换 { } 换行时
 * 产生的反斜杠再次转义。
 */
export function escapeAssText (s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N')
}

/**
 * 生成卡拉OK扫光标签。
 *
 * ⚠️ 每个 \kf 的时长要【覆盖到下一个词的起点】，而不是本词的 duration。
 * 词之间存在空隙（停顿），若只用 duration，扫光会在空隙处停住，
 * 与音频脱节——听着念到了下一个词，画面上还没亮。
 *
 * ⚠️ 按【词】分组，不按字。Azure 给的就是词级时间戳（「震惊」是一个整词）。
 */
export function buildKaraoke (line: SubtitleLine): string {
  return line.words.map((word, i) => {
    const next = line.words[i + 1]
    const spanMs = next ? next.offsetMs - word.offsetMs : word.durationMs
    // {\kf..} 是我们自己生成的标签，不转义；word.text 是用户/ASR 来的文本，要转义
    return `{\\kf${Math.round(spanMs / 10)}}${escapeAssText(word.text)}`   // ASS 的 \k 单位是厘秒
  }).join('')
}

/**
 * 生成完整 ASS：字幕 + 固定文本，同一个文件。
 *
 * 设计文档第 7 节：字幕、标题、免责声明是同一个东西的不同填法，
 * 不需要两套机制。这个文件既喂给 ffmpeg 烧录，也喂给浏览器的 JASSUB 预览——
 * 同一个 libass，所以所见即所得是架构保证的，不是"努力对齐"出来的。
 *
 * 颜色格式是 &HAABBGGRR —— BGR 顺序，不是 RGB。经典陷阱。
 * PrimaryColour = 已唱色，SecondaryColour = 未唱色（不是字面意思上的"主/次"）。
 */
export function buildAss (opts: BuildAssOptions): string {
  const { lines, overlays, aspect, durationMs, mode } = opts

  const dialogues = lines.map((line) => {
    const text = mode === 'karaoke'
      ? buildKaraoke(line)
      : line.words.map((w) => escapeAssText(w.text)).join('')
    return `Dialogue: 0,${formatAssTime(line.startMs)},${formatAssTime(line.endMs)},Sub,,0,0,0,,${text}`
  })

  // Layer 1 > Layer 0：固定文本压在字幕之上，不会被盖住
  const overlayLines = overlays.map((o) => {
    const start = formatAssTime(o.startMs ?? 0)
    const end = formatAssTime(o.endMs ?? durationMs)
    return `Dialogue: 1,${start},${end},${o.style},,0,0,0,,${escapeAssText(o.content)}`
  })

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${aspect.width}
PlayResY: ${aspect.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${FONT_FAMILY},64,&H0000E5FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,2,60,60,300,1
Style: Title,${FONT_FAMILY},96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0,100,100,0,0,1,6,0,8,60,60,120,1
Style: Disclaimer,${FONT_FAMILY},32,&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${overlayLines.join('\n')}
${dialogues.join('\n')}
`
}
