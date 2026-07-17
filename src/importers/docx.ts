import mammoth from 'mammoth'
import { normalizeScript } from './sanitize.js'

/** .docx 是 zip + XML，解析成熟，没有 .doc 那些编码问题 */
export async function importDocx (buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  const text = normalizeScript(value)
  if (text.length === 0) throw new Error('.docx 里没有提取到文本')
  return text
}
