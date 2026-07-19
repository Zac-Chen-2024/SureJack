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
  return false   // voice/export 是系统生成的，不接受上传
}

/**
 * 上传格式白名单。早失败：不支持的格式在上传时就拒绝，
 * 不要等到渲染时 ffmpeg 报一句看不懂的错（设计文档第 13 节）。
 *
 * MIME 和扩展名都要对——单看 MIME 可被伪造，单看扩展名同理。
 */
export function isAllowedUpload (mime: string, originalName: string, kind: AssetKind): boolean {
  if (!isAllowedExt(originalName, kind)) return false
  if (kind === 'video') return VIDEO_MIME.includes(mime)
  if (kind === 'bgm') return AUDIO_MIME.includes(mime)
  return false   // voice/export 是系统生成的，不接受上传
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
