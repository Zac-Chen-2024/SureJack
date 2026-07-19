import { ASPECT_PRESETS } from '../config.js'
import { segmentLines } from './segment.js'
import { buildAss, DEFAULT_SUBTITLE_FONT_SIZE } from './ass.js'
export { DEFAULT_SUBTITLE_FONT_SIZE }
import type { Project } from '../db/user-db.js'
import type { WordTiming, SubtitleLine, TextOverlay, AspectPreset } from '../types.js'

/**
 * 一个项目 → 字幕行 / ASS 全文。
 *
 * ⚠️ 这个文件存在的唯一理由：**导出烧录和浏览器预览必须拿到逐字节相同的
 * ASS**。字幕、标题、免责声明、画幅、分行字数——只要有一处两边各自算，
 * 样式就会随时间漂移，而症状是「预览好好的，导出不对」，极难排查。
 * 所以 `src/queue/routes.ts`（导出）和 `src/subtitles/routes.ts`（预览）
 * 都只准调这里，不准自己拼。新增第三个消费方时同理。
 *
 * 纯派生、无 IO、不落库（设计文档第 4 节）：词时间轴才是真相来源，
 * 字幕行每次现算。词表几千条、segmentLines 是 O(n)，开销可忽略。
 */

/** 竖屏一行的字数上限。竖屏 1080 宽、64 号字，超过这个数会顶到边 */
export const SUBTITLE_MAX_CHARS = 14

export const DISCLAIMER = '小说内容纯属虚构，无不良引导'

const DEFAULT_ASPECT: AspectPreset = { name: '9:16', width: 1080, height: 1920 }

/** 项目的画幅预设。库里存的是自由字符串，认不出来时回落竖屏而不是崩 */
export function aspectOf (project: Project): AspectPreset {
  return ASPECT_PRESETS[project.aspectRatio] ?? DEFAULT_ASPECT
}

/**
 * 字幕距底边的可选上界：**画面高度的一半**。
 *
 * 为什么要有上界：MarginV 直接进 ASS 样式行，libass 照单全收。给个负数
 * 或者比画面还高的值，字幕就渲染到画外去了——用户看到的是"字幕没了"，
 * 而不是"我拖过头了"，这种失败模式完全不可自证。取一半是因为再往上
 * 就越过画面中线，字幕跑到上半屏，那已经不是"调高度"而是换版式了。
 */
export function maxSubtitleMarginV (aspectRatio: string): number {
  return Math.floor((ASPECT_PRESETS[aspectRatio] ?? DEFAULT_ASPECT).height / 2)
}

/**
 * 字幕能贴多低。
 *
 * 免责声明固定在 MarginV=90、字号 32，所以它占据 90～122 这一段。
 * 字幕从自己的 MarginV 往上长，底边就是 MarginV——低于 122 就会压在
 * 免责声明上。取 160 是在 122 之上再留约 38px 呼吸，两行不会挤在一起。
 *
 * 【为什么给字幕设下限而不是让免责声明避让】：免责声明是固定的合规
 * 标记，位置稳定本身就是它的价值；每条片子的它都在同一个地方，观众
 * 扫一眼就跳过。让它随字幕浮动，反而会让人以为那是内容的一部分。
 */
export const MIN_SUBTITLE_MARGIN_V = 160


export const MIN_SUBTITLE_FONT_SIZE = 36
export const MAX_SUBTITLE_FONT_SIZE = 120

export function clampSubtitleFontSize (value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SUBTITLE_FONT_SIZE
  return Math.min(MAX_SUBTITLE_FONT_SIZE, Math.max(MIN_SUBTITLE_FONT_SIZE, Math.round(value)))
}

/**
 * 把用户给的值钳进合法范围并取整（像素）。
 *
 * ⚠️ **调用点在路由层，不要指望前端**：滑块的 min/max 只是体验，
 * 接口是公开的，脏值不能靠界面挡。
 */
export function clampSubtitleMarginV (value: number, aspectRatio: string): number {
  const max = maxSubtitleMarginV(aspectRatio)
  // 极窄画幅上限可能低于下限（比如 16:9 高 1080，上限 540 > 160，没问题；
  // 但若将来加了更矮的画幅），此时以上限为准，不能返回一个大于上限的值
  const lo = Math.min(MIN_SUBTITLE_MARGIN_V, max)
  return Math.min(max, Math.max(lo, Math.round(value)))
}

/**
 * 从存下来的词时间轴推字幕行。还没生成配音时 wordTimingsJson 为 null，
 * 返回空数组——「没有字幕」是正常状态，不是错误。
 *
 * ⚠️ **两条来源的分行方式不同，靠 subtitleMode 分流**：
 *
 * - `karaoke`（AI 配音）：wordTimingsJson 是 Azure 的**词级**时间轴，
 *   一个 WordTiming 是一个词，要靠 segmentLines 按标点+字数攒成行。
 * - `line`（自备 SRT）：wordTimingsJson 是**句级**的，一个 WordTiming
 *   就是一条 cue 的整句话，分行是用户/剪辑软件已经断好的。这时
 *   **一条时间轴项 = 一行字幕，不再断句**。
 *
 * 【为什么不能对 SRT 也跑 segmentLines】：两条都很短的相邻 cue（'甲'、
 * '乙'）加起来才 2 个字，远不到 14 字上限，会被攒进同一行，显示时间从
 * 第一条的起点一路盖到第二条的终点，中间的静音也顶着字幕；长 cue 则会
 * 被拦腰切开，用户断好的行全废。srt.ts 和 from-srt.ts 的注释里写了同一
 * 条禁令，这里是它唯一的执行点。
 *
 * 【subtitleMode 在这里的含义】：它不只是渲染开关（buildAss 的整句 vs
 * 扫光），也是**时间轴粒度的标记**——`line` 蕴含「words 是句级的」。
 * 将来若要给 AI 配音路径加一个「整句显示」的渲染选项，**不能复用这个
 * 值**，否则词级时间轴会被当成句级，每个词各成一行。那种需求要另加字段。
 */
export function deriveSubtitleLines (project: Project): SubtitleLine[] {
  const words: WordTiming[] = JSON.parse(project.wordTimingsJson ?? '[]')
  if (project.subtitleMode === 'line') {
    return words.map((w) => ({
      startMs: w.offsetMs,
      endMs: w.offsetMs + w.durationMs,
      words: [w],
    }))
  }
  return segmentLines(words, SUBTITLE_MAX_CHARS)
}

/**
 * 项目的完整 ASS：字幕 + 标题 + 免责声明，同一个文件
 * （设计文档第 7 节：它们是同一个东西的不同填法）。
 */
export function buildAssForProject (project: Project): string {
  const overlays: TextOverlay[] = [
    { content: DISCLAIMER, style: 'Disclaimer', startMs: null, endMs: null },
    { content: project.name, style: 'Title', startMs: null, endMs: null },
  ]
  return buildAss({
    lines: deriveSubtitleLines(project),
    overlays,
    aspect: aspectOf(project),
    durationMs: project.ttsDurationMs ?? 0,
    mode: project.subtitleMode,
    // 只抬字幕。免责声明那一行是固定的合规标记不是内容，留在原地。
    subtitleMarginV: project.subtitleMarginV,
    subtitleFontSize: clampSubtitleFontSize(project.subtitleFontSize),
  })
}
