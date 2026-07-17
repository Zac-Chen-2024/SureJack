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

/**
 * 剥掉字符串开头的 UTF-8 BOM（U+FEFF）。
 *
 * 为什么需要：Windows 记事本存 UTF-8 文件会加 BOM，不剥的话首字符是
 * 不可见的 ﻿——它会混进第一行文本/第一条字幕，也会让 TTS 多念一个空。
 * `.txt` 和 `.srt` 都要剥，原先各自实现了一份同样的正则，这里统一成
 * 唯一实现，避免以后只改一处导致行为分裂。
 */
export function stripBom (s: string): string {
  return s.replace(/^﻿/, '')
}

/**
 * 启发式判断文本是不是乱码。
 *
 * 为什么必须有：无论是 catdoc 解析 .doc，还是 chardet 猜错 .txt 的编码，
 * 底层库都【会静默失败】——喂它编码猜错的字节，它照样吐出乱码却报告
 * 成功。乱码悄悄流进配音环节，用户会拿到一条念着乱码的视频——
 * 比直接报错糟糕得多。
 *
 * 判据：乱码的典型形态是 UTF-8/GBK 字节被按单字节编码解读，
 * 产出大量 Latin-1 补充区字符（À-ÿ）。正常文本里这类字符很少。
 *
 * 原先只在 doc.ts 里实现、只服务 .doc 路径；.txt 路径的编码探测
 * 同样可能猜错（`chardet.analyse` 对短文本尤其不可靠），所以挪到
 * 这个通用清洗模块，doc.ts 和 txt.ts 共用同一份判断逻辑。
 */
export function looksLikeMojibake (s: string): boolean {
  const text = s.trim()
  if (text.length === 0) return true

  const chars = [...text]
  const latin1Supplement = chars.filter((c) => {
    const cp = c.codePointAt(0)!
    return cp >= 0xc0 && cp <= 0xff
  }).length

  // 正常中文/英文里 À-ÿ 占比极低；乱码里能占到三成以上。
  // 阈值 15% 给法语人名之类的正常用法留了余量。
  return latin1Supplement / chars.length > 0.15
}
