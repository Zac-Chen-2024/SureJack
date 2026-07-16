/**
 * 还原 XML 实体。
 *
 * 为什么需要：Azure 的 SDK 把文本包进 SSML 时做 XML 转义，
 * 而 WordBoundary 事件报告的是【转义后】的形态——输入 A&B，
 * 事件的 text 回来是 '&amp;'。不还原的话字幕会字面显示 &amp;。
 * 已实测，见 docs/superpowers/spikes/RESULTS.md。
 *
 * 用单次 replace 而非链式：链式会把 &amp;lt; 二次解码成 <。
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

export function unescapeXml (s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
}

/**
 * 归一化文案：连续空白（含换行）压成单空格。
 *
 * 为什么：段落间的空行会让 TTS 产生过长停顿。标点保留——
 * 它们是断句的依据，而且 Azure 会为标点单独触发事件。
 */
export function normalizeScript (s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
