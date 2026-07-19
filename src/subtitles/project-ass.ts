import { ASPECT_PRESETS } from '../config.js'
import { segmentLines } from './segment.js'
import { buildAss } from './ass.js'
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
 * 从存下来的词时间轴推字幕行。还没生成配音时 wordTimingsJson 为 null，
 * 返回空数组——「没有字幕」是正常状态，不是错误。
 */
export function deriveSubtitleLines (project: Project): SubtitleLine[] {
  const words: WordTiming[] = JSON.parse(project.wordTimingsJson ?? '[]')
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
  })
}
