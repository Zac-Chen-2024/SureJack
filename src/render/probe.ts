import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * 用 ffprobe 探测媒体文件时长，单位毫秒。
 *
 * 自带配音路径（Task 11.5）要用这个而不是最后一条字幕的结束时间：
 * 字幕的最后一条 cue 结束点往往早于音频真正结束点（尾部可能有
 * 自然静音），成片时长必须跟音频走完整长度，否则会把配音掐断。
 */
export async function probeDurationMs (path: string): Promise<number> {
  let stdout: string
  try {
    const r = await exec('ffprobe', [
      '-hide_banner', '-loglevel', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1',
      path,
    ])
    stdout = r.stdout
  } catch (e) {
    throw new Error(`探测媒体时长失败：${path}\n${(e as Error).message}`)
  }

  const match = stdout.match(/duration=([\d.]+)/)
  if (!match) {
    throw new Error(`ffprobe 输出无法解析媒体时长：${path}\n${stdout.trim()}`)
  }
  return Math.round(parseFloat(match[1]!) * 1000)
}
