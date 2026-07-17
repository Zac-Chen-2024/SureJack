import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeScript } from './sanitize.js'

const exec = promisify(execFile)

/**
 * 启发式判断抽取结果是不是乱码。
 *
 * 为什么必须有：catdoc【会静默失败】——喂它一个非 .doc 文件，
 * 它吐出乱码却返回退出码 0（阶段 0 实测）。所以退出码完全不能信。
 * 乱码悄悄流进配音环节，用户会拿到一条念着乱码的视频——
 * 比直接报错糟糕得多。
 *
 * 判据：乱码的典型形态是 UTF-8/GBK 字节被按单字节编码解读，
 * 产出大量 Latin-1 补充区字符（À-ÿ）。正常文本里这类字符很少。
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

/**
 * 用 catdoc 抽取 .doc 文本。
 *
 * antiword 已出局——对中文 .doc 直接崩溃（阶段 0 实测）。
 * .doc 支持是【尽力而为】的降级路径：读不出来就明确拒绝，绝不假装成功。
 */
export async function importDoc (path: string): Promise<string> {
  let stdout: string
  try {
    const r = await exec('catdoc', ['-d', 'utf-8', path], { maxBuffer: 32 * 1024 * 1024 })
    stdout = r.stdout
  } catch (e) {
    throw new Error(
      `.doc 解析失败：${(e as Error).message}\n` +
      '请在 Word 里另存为 .docx 后重新上传。'
    )
  }

  const text = normalizeScript(stdout)

  // 退出码是 0 也不能信——必须看内容
  if (looksLikeMojibake(text)) {
    throw new Error(
      '.doc 解析出来是乱码（这个老格式的中文编码支持不可靠）。\n' +
      '请在 Word 里另存为 .docx 后重新上传。'
    )
  }

  return text
}
