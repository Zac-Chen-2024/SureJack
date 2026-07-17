import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeScript, looksLikeMojibake } from './sanitize.js'

const exec = promisify(execFile)

// looksLikeMojibake 现在是 sanitize.ts 的通用实现（.txt 路径也要用它）。
// 从这里重新导出，保持既有调用点（本文件下方 + tests/importers/doc.test.ts）不用改 import 路径。
export { looksLikeMojibake } from './sanitize.js'

/**
 * 用 catdoc 抽取 .doc 文本。
 *
 * antiword 已出局——对中文 .doc 直接崩溃（阶段 0 实测）。
 * .doc 支持是【尽力而为】的降级路径：读不出来就明确拒绝，绝不假装成功。
 *
 * catdoc 本身【会静默失败】——喂它一个非 .doc 文件，它吐出乱码却返回
 * 退出码 0（阶段 0 实测）。所以退出码完全不能信，必须靠 looksLikeMojibake 看内容。
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
