/**
 * 把 ASS 的时间轴整体平移，并裁到一个时间窗内。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 母带烧录改成【分段烧】之后（每段一分钟，烧完存一段），每一段都是
 * 从背景轨的第 T 秒开始、独立编码的一个片子——它自己的时间从 0 起算。
 * 而 ASS 里的时间是【整条片子的绝对时间】。直接把整份 ASS 交给某一段，
 * 那一段会从第一句字幕开始放，整段字幕全错。
 *
 * 所以每段要一份【平移过的 ASS】：把所有时间减去这一段的起点，
 * 并丢掉不在这一段里的行。
 *
 * ── 为什么是平移 ASS，不是让 ffmpeg 保持时间戳 ──────────────────────
 * ffmpeg 那条路是 `-ss` + `-copyts`，让滤镜看到原始时间戳。能走通，但
 * 时间戳会渗进后面的封装和 concat，边界情况很多（负时间戳、muxdelay、
 * avoid_negative_ts 各有各的脾气）。
 * 平移 ASS 是【纯字符串变换】：可测、可复现、出了问题一眼看得出来。
 * 字幕本来就是我们自己生成的，改它比跟 ffmpeg 的时间戳较劲省事得多。
 */

/** ASS 的时间格式：H:MM:SS.cc（百分之一秒） */
export function parseAssTime (s: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(s.trim())
  if (m === null) return null
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10
}

export function formatAssTime (ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const cs = Math.floor(clamped / 10) % 100
  const total = Math.floor(clamped / 1000)
  const h = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  return `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * 平移 + 裁剪。
 *
 * @param ass       整条片子的 ASS 全文
 * @param startMs   这一段从整片的第几毫秒开始
 * @param lengthMs  这一段有多长
 *
 * ⚠️【和窗口有交集就保留，不是"完全落在窗口内才保留"】。一句字幕横跨
 * 段边界是常态（段长一分钟，字幕两三秒，60 句里总有一句压在线上）。
 * 只留"完全在内"的话，每个边界都会吞掉一句——一条 13 分钟的片子
 * 13 个边界，就是十几句字幕凭空消失，而且只在分段烧录时才出现。
 *
 * 裁到边界之外的部分由 libass 自己处理：起点为负就从 0 开始显示，
 * 超出段尾的部分下一段会接着显示（因为下一段也保留了这一句）。
 */
export function shiftAss (ass: string, startMs: number, lengthMs: number): string {
  const endMs = startMs + lengthMs
  const out: string[] = []
  for (const line of ass.split('\n')) {
    if (!line.startsWith('Dialogue:')) { out.push(line); continue }
    /*
     * Dialogue 的前 3 个字段是 Layer,Start,End，后面还有 Name/Margin/Effect/Text，
     * 而 Text 里【可以包含逗号】（\move(…,…) 之类），所以只能切前几段、
     * 剩下的原样接回去。用 split(',') 全切会把特效参数拆散。
     */
    const head = line.slice('Dialogue:'.length)
    const parts = head.split(',')
    if (parts.length < 3) { out.push(line); continue }
    const s = parseAssTime(parts[1] ?? '')
    const e = parseAssTime(parts[2] ?? '')
    if (s === null || e === null) { out.push(line); continue }

    // 和这一段没有交集 → 丢掉
    if (e <= startMs || s >= endMs) continue

    parts[1] = formatAssTime(s - startMs)
    parts[2] = formatAssTime(e - startMs)
    out.push(`Dialogue:${parts.join(',')}`)
  }
  return out.join('\n')
}
