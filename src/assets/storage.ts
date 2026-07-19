import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { userDbDir } from '../auth/whitelist.js'
import type { AssetKind } from '../db/user-db.js'

/**
 * 某项目的素材目录。
 *
 * ⚠️ 路径由【会话身份】拼出，绝不接受外部传入的路径（设计文档第 3 节）。
 * userDbDir 先过白名单校验，再拼 projectId——所以"改个 URL 看别人的视频"
 * 这条路在结构上不存在。
 */
export function assetDir (userName: string, whitelist: string[], projectId: string): string {
  const base = userDbDir(userName, whitelist)   // 先过白名单，防穿越
  if (!/^[A-Za-z0-9-]+$/.test(projectId)) {
    throw new Error('非法的项目标识')            // projectId 是 UUID，只允许这些字符
  }
  return resolve(join(base, 'assets', projectId))
}

/** 拼出某个素材文件的完整路径，文件名必须是纯文件名（无路径分隔符） */
export function assetPathFor (
  userName: string, whitelist: string[], projectId: string, fileName: string,
): string {
  const dir = assetDir(userName, whitelist, projectId)
  // 文件名不能含路径分隔符或 ..，basename 后必须与原值相同才放行
  if (fileName !== basename(fileName) || fileName.includes('..') || fileName.includes('\\')) {
    throw new Error('非法的文件名')
  }
  const full = resolve(join(dir, fileName))
  if (!full.startsWith(dir + '/')) {
    throw new Error('拒绝：路径逃逸')            // 双保险
  }
  return full
}

const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm']
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
const AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/flac']
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac']
/** 自备配音接受的扩展名。比 BGM 窄：不收 flac，配音没人用无损 */
const VOICE_EXT = ['.mp3', '.wav', '.m4a', '.aac']
const SRT_EXT = ['.srt']

/**
 * 只看扩展名的格式白名单。
 *
 * 扫描磁盘目录时【没有 MIME】可看——MIME 是 HTTP 上传才带的头部，
 * 素材库扫描面对的是已经躺在盘上的文件。所以把扩展名这一半单独抽出来，
 * 让上传校验和目录扫描共用同一份扩展名清单，不会各自漂移。
 */
export function isAllowedExt (originalName: string, kind: AssetKind): boolean {
  const ext = extname(originalName).toLowerCase()
  if (kind === 'video') return VIDEO_EXT.includes(ext)
  if (kind === 'bgm') return AUDIO_EXT.includes(ext)
  if (kind === 'voice') return VOICE_EXT.includes(ext)
  if (kind === 'srt') return SRT_EXT.includes(ext)
  return false   // export 是系统生成的，不接受上传
}

/**
 * 上传格式白名单。早失败：不支持的格式在上传时就拒绝，
 * 不要等到渲染时 ffmpeg 报一句看不懂的错（设计文档第 13 节）。
 *
 * MIME 和扩展名都要对——单看 MIME 可被伪造，单看扩展名同理。
 *
 * ⚠️ **srt 是例外，只校验扩展名**。`.srt` 没有被广泛实现的标准 MIME：
 * Chrome 报 `application/x-subrip`，Firefox 报 `application/octet-stream`，
 * 有些平台干脆是空串。列一份 MIME 白名单只会把正常用户挡在门外，
 * 却挡不住任何真实威胁——文件落盘后【只被 parseSrt 当纯文本解析】，
 * 从不执行、也不喂给 ffmpeg，MIME 声称是什么都不影响处理方式。
 */
export function isAllowedUpload (mime: string, originalName: string, kind: AssetKind): boolean {
  if (!isAllowedExt(originalName, kind)) return false
  if (kind === 'video') return VIDEO_MIME.includes(mime)
  if (kind === 'bgm') return AUDIO_MIME.includes(mime)
  if (kind === 'voice') return AUDIO_MIME.includes(mime)
  if (kind === 'srt') return true   // 见上：扩展名已经把关，MIME 不可靠
  return false   // export 是系统生成的，不接受上传
}

/**
 * 按扩展名给出回放用的 Content-Type。
 *
 * ⚠️ 用的是【落盘时的扩展名】，不是上传者声称的 MIME——上传那一关
 * （isAllowedUpload）已经把两者都校验过并锁死成一小撮已知扩展名，
 * 这里再信一次外部输入没有意义。认不出来的一律 application/octet-stream：
 * 浏览器不会拿它当媒体播，比猜错一个 MIME 更安全。
 */
export function playbackMimeFor (filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac',
    // 自备字幕：用 text/plain 而不是 application/x-subrip，前端要能直接
    // 读文本；text/plain 不会被浏览器当脚本执行，同域下也没有 XSS 面
    '.srt': 'text/plain; charset=utf-8',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 解析 Range 请求头，返回闭区间 [start, end]（字节）。
 *
 * 只支持单区间的 `bytes=a-b` / `bytes=a-` / `bytes=-n`——多区间要回
 * multipart/byteranges，媒体元素从不用它。解析不出来返回 null，调用方
 * 退回整文件 200（这是规范允许的：Range 是建议，不是命令）。
 * 越界返回 'invalid'，调用方要回 416，不能悄悄夹逼成一个错误的区间。
 */
export function parseRange (header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null

  let start: number, end: number
  if (rawStart === '') {
    // bytes=-n：最后 n 个字节
    const n = Number(rawEnd)
    if (n <= 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** 把上传流落盘。返回实际路径与字节数。 */
export async function saveAsset (opts: {
  userName: string; whitelist: string[]; projectId: string
  fileName: string; stream: Readable
}): Promise<{ path: string; size: number }> {
  const dir = assetDir(opts.userName, opts.whitelist, opts.projectId)
  await mkdir(dir, { recursive: true })
  const full = assetPathFor(opts.userName, opts.whitelist, opts.projectId, opts.fileName)

  let size = 0
  opts.stream.on('data', (chunk: Buffer) => { size += chunk.length })
  await pipeline(opts.stream, createWriteStream(full))
  return { path: full, size }
}
