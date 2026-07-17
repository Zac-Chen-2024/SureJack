import chardet from 'chardet'
import iconv from 'iconv-lite'
import { normalizeScript, stripBom, looksLikeMojibake } from './sanitize.js'

/**
 * 读 txt，自动探测编码。
 *
 * 为什么必须做：中文 txt 在国内大量是 GBK / GB18030，
 * 按 UTF-8 硬读会得到满屏乱码——而且是"文件传上去了、项目也建了、
 * 就是文字全是问号"这种最难受的失败。
 *
 * 空文本和乱码都必须在这里拦住，不能让它们一路流进 TTS：
 * 空字符串送进 Azure 合成不出任何有意义的语音/词级时间戳（对应 I4 的
 * 零词级事件兜底会在更下游再拦一次，但源头能挡住就不该指望下游）；
 * 乱码送进去会合成出一段"念着乱码"的成片——比直接报错糟糕得多。
 * `.doc` 路径（doc.ts）早就有这两道检查，`.docx` 也对空文本抛错，
 * 这里补齐 `.txt` 路径，三种格式的失败方式保持一致。
 */
export function importTxt (buf: Buffer): { text: string; encoding: string; confidence: number } {
  const matches = chardet.analyse(buf)
  const best = matches[0]
  const encoding = best?.name ?? 'UTF-8'
  // confidence 暂未参与下面的判断——只是原样报告 chardet 的探测置信度，
  // 留给将来 UI 提示用（比如"编码猜测置信度低，请确认内容正常"）。
  // 不用它来做门槛判断的原因：chardet 对短文本的置信度经常虚高或虚低，
  // 不如直接看解码后的内容是不是乱码（looksLikeMojibake）可靠。
  const confidence = best?.confidence ?? 0

  const decoded = iconv.encodingExists(encoding)
    ? iconv.decode(buf, encoding)
    : buf.toString('utf-8')

  const text = normalizeScript(stripBom(decoded))

  if (text.length === 0) {
    throw new Error('文件是空的或不含可读文本，请检查文件内容后重新上传。')
  }

  if (looksLikeMojibake(text)) {
    throw new Error(
      '.txt 解析出来疑似乱码（编码探测可能失败）。\n' +
      '请把文件另存为 UTF-8 编码后重新上传，或者直接把文案粘贴进来。'
    )
  }

  return { text, encoding, confidence }
}
