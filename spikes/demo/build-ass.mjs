/**
 * 把词级时间戳变成 ASS：字幕 + 标题 + 免责声明，全在一个文件里。
 *
 * 这是设计文档第 7 节断句逻辑的第一次真正实现：
 *   - 按标点边界断行，叠加字数上限
 *   - 每行的起止时间完全由时间戳推导，不手动指定
 *   - \kf 按「词」分组（Azure 给的是词级，不是字级）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TIMINGS = '/root/SureJack/spikes/demo/timings.json'
const OUT = '/root/SureJack/spikes/demo/subtitle.ass'

const W = 1080, H = 1920
const MAX_CHARS = 14          // 单行字数上限，竖屏放不下更多
const TITLE = '包子'
const DISCLAIMER = '小说内容纯属虚构，无不良引导'

const { durationMs, events } = JSON.parse(readFileSync(TIMINGS, 'utf-8'))

/** 反转义 XML 实体——Azure 的 WordBoundary 回来的是转义后的形态（已实测） */
const unescape = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")

const cs = (ms) => Math.round(ms / 10)   // 毫秒 → 厘秒（ASS 的 \k 单位）

function assTime (ms) {
  const t = Math.max(0, ms) / 1000
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${h}:${String(m).padStart(2, '0')}:${s}`
}

// ── 断句：按标点边界断行，叠加字数上限 ─────────────────────────
const lines = []
let cur = []

const flush = () => { if (cur.length) { lines.push(cur); cur = [] } }

for (const e of events) {
  const text = unescape(e.text)
  const isPunct = e.boundaryType.toLowerCase().includes('punct')

  cur.push({ ...e, text, isPunct })

  // 标点是天然的断句点——Azure 白送的，不用自己分词
  if (isPunct) { flush(); continue }

  // 字数上限兜底：竖屏一行放不下太多字
  const chars = cur.reduce((n, w) => n + [...w.text].length, 0)
  if (chars >= MAX_CHARS) flush()
}
flush()

console.log(`${events.length} 个事件 → ${lines.length} 行字幕`)

// ── 生成字幕事件 ────────────────────────────────────────────
const dialogues = []
for (const line of lines) {
  const start = line[0].offsetMs
  const last = line[line.length - 1]
  const end = last.offsetMs + last.durationMs

  // \kf 时长要覆盖到下一个词的起点，否则词间空隙会让扫光卡顿、与音频脱节
  const parts = line.map((w, i) => {
    const next = line[i + 1]
    const span = next ? next.offsetMs - w.offsetMs : w.durationMs
    return `{\\kf${cs(span)}}${w.text}`
  })

  dialogues.push(
    `Dialogue: 0,${assTime(start)},${assTime(end)},Sub,,0,0,0,,${parts.join('')}`
  )
}

// ── 标题与免责声明：全程常驻，就是 0 到片尾 ──────────────────
const full = `${assTime(0)},${assTime(durationMs)}`
const overlays = [
  `Dialogue: 1,${full},Title,,0,0,0,,${TITLE}`,
  `Dialogue: 1,${full},Disclaimer,,0,0,0,,${DISCLAIMER}`,
]

// ── 样式 ───────────────────────────────────────────────────
// 颜色是 &HAABBGGRR —— BGR 顺序，不是 RGB
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Noto Sans CJK SC,64,&H0000E5FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,2,60,60,300,1
Style: Title,Noto Sans CJK SC,96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0,100,100,0,0,1,6,0,8,60,60,120,1
Style: Disclaimer,Noto Sans CJK SC,32,&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${overlays.join('\n')}
${dialogues.join('\n')}
`

writeFileSync(OUT, ass)
console.log(`✅ 已写入 ${OUT}`)
console.log(`   标题「${TITLE}」· 免责声明常驻 0–${(durationMs / 1000).toFixed(1)}s`)
console.log(`\n   前 3 行字幕预览：`)
dialogues.slice(0, 3).forEach((d) => console.log('   ' + d.slice(0, 110)))
