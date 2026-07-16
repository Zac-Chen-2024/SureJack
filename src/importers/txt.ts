import chardet from 'chardet'
import iconv from 'iconv-lite'
import { normalizeScript } from './sanitize.js'

/**
 * 读 txt，自动探测编码。
 *
 * 为什么必须做：中文 txt 在国内大量是 GBK / GB18030，
 * 按 UTF-8 硬读会得到满屏乱码——而且是"文件传上去了、项目也建了、
 * 就是文字全是问号"这种最难受的失败。
 */
export function importTxt (buf: Buffer): { text: string; encoding: string; confidence: number } {
  const matches = chardet.analyse(buf)
  const best = matches[0]
  const encoding = best?.name ?? 'UTF-8'
  const confidence = best?.confidence ?? 0

  const decoded = iconv.encodingExists(encoding)
    ? iconv.decode(buf, encoding)
    : buf.toString('utf-8')

  // 剥 BOM：Windows 记事本存 UTF-8 会加，不剥的话首字符是不可见的 ﻿，
  // 它会混进第一行字幕，也会让 TTS 多念一个空
  const text = decoded.replace(/^﻿/, '')

  return { text: normalizeScript(text), encoding, confidence }
}
