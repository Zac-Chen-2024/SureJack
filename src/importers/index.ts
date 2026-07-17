import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { importTxt } from './txt.js'
import { importDoc } from './doc.js'
import { importDocx } from './docx.js'

export { unescapeXml, normalizeScript } from './sanitize.js'

/**
 * 把任意支持的格式变成干净的 UTF-8 文本。
 *
 * 外界不需要知道文件格式的存在——编码探测、格式解析、
 * 失败检测全在这个模块里解决。
 */
export async function importScript (path: string): Promise<string> {
  const ext = extname(path).toLowerCase()

  switch (ext) {
    case '.txt':
      return importTxt(await readFile(path)).text
    case '.docx':
      return importDocx(await readFile(path))
    case '.doc':
      return importDoc(path)   // catdoc 直接读文件，不经 Buffer
    default:
      throw new Error(`不支持的格式：${ext || '(无扩展名)'}。支持 .txt / .docx / .doc，也可以直接粘贴文案。`)
  }
}
