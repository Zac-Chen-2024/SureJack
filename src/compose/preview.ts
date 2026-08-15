import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const run = promisify(execFile)

/**
 * 预览专用的【低码率 HLS 分段】。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 母带实测 **7.5 Mbps**（13 分钟 726MB）。跨洲的实际可用带宽常常只有
 * 2–5 Mbps——也就是说播放速度【根本追不上片子的码率】。用户在国外看预览
 * 一直转圈，不是缓冲策略的问题，是在等一个追不上的东西。
 *
 * 所以两件事一起做：
 *   ① 降码率：540×960 / 约 0.9 Mbps。13 分钟从 726MB 变成约 90MB，
 *      七八倍的差距。手机屏幕本来就只有那么大，肉眼几乎无差别。
 *   ② 切成 6 秒一段的 HLS：播放器只拉当前要播的那几段，拖进度条直接跳，
 *      不用为了看第 10 分钟先把前面 9 分钟拉下来。
 *
 * 单靠 ② 不够——每段还是 7.5 Mbps 的料，跨洲照样追不上；
 * 单靠 ① 也不够——长片子拖进度条仍然要重新缓冲。两个一起才顺。
 *
 * ── 为什么【一次编码直接出分段】 ────────────────────────────────────
 * 先编一份低码率 mp4、再切段的话，盘上会同时躺着 mp4 和一堆分段——同样的
 * 内容存两份。ffmpeg 可以直接输出 HLS，省掉那一份。
 *
 * ── 为什么不带音轨 ──────────────────────────────────────────────────
 * 母带本来就没有音轨（配音和音乐是独立的两条流，播放器自己叠）。
 * 这反而让 HLS 简单了：分段里只有画面，不用操心音画在段边界上的对齐。
 */

export const PREVIEW_DIR = 'preview'
export const PREVIEW_PLAYLIST = 'index.m3u8'

/** 预览画面的高。540×960 在手机上看不出和 1080 的差别，字幕照样清楚 */
const PREVIEW_HEIGHT = 960
/** 一段多长。6 秒是流媒体的常用值：再短索引变长、请求变多，再长起播变慢 */
const SEGMENT_SEC = 6

/** 这个项目的预览分段在哪儿 */
export function previewDir (assetDirPath: string): string {
  return join(assetDirPath, PREVIEW_DIR)
}

/** 预览已经就绪了吗（索引文件在就算） */
export function hasPreview (assetDirPath: string): boolean {
  return existsSync(join(previewDir(assetDirPath), PREVIEW_PLAYLIST))
}

/**
 * 正在生成的那些。**并发去重**是必须的，不是优化：
 * 烧录完成后会在后台生成一份，而用户可能同时点开预览也触发一次——
 * 两个 ffmpeg 会【互相清空对方的目录】（下面第一步就是 rm -rf），
 * 结果是两边都产出残缺的分段，而索引看起来是好的。
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * 从母带生成预览分段。**幂等 + 并发安全**：已经有了就不重做，
 * 正在做就等那一次的结果。
 *
 * @param force 母带重烧过了，预览必须跟着重做
 */
export async function buildPreview (
  assetDirPath: string, masterPath: string, opts: { force?: boolean } = {},
): Promise<void> {
  const running = inFlight.get(assetDirPath)
  if (running !== undefined) return running
  const task = buildPreviewOnce(assetDirPath, masterPath, opts)
  inFlight.set(assetDirPath, task)
  try { await task } finally { inFlight.delete(assetDirPath) }
}

async function buildPreviewOnce (
  assetDirPath: string, masterPath: string, opts: { force?: boolean } = {},
): Promise<void> {
  const dir = previewDir(assetDirPath)
  if (opts.force !== true && hasPreview(assetDirPath)) return
  if (!existsSync(masterPath)) throw new Error('还没有母带，生成不了预览')

  /*
   * 【先清空再生成】。留着上一版的分段会出事：新索引只列新分段，旧分段
   * 变成没人引用的垃圾一直占地方；更糟的是重烧后段数变少时，
   * 播放器可能拿到旧索引的缓存去拉已经被覆盖的段。
   */
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', masterPath,
    '-an',                                   // 母带本来就没音轨，明确一下
    '-vf', `scale=-2:${PREVIEW_HEIGHT}`,     // -2：宽度按比例走并保持偶数
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-maxrate', '1200k', '-bufsize', '2400k',
    '-pix_fmt', 'yuv420p',
    '-g', String(SEGMENT_SEC * 30),          // 关键帧对齐段长，否则切不准
    '-keyint_min', String(SEGMENT_SEC * 30),
    '-sc_threshold', '0',                    // 不让场景切换插入额外关键帧
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SEC),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(dir, 'seg-%04d.ts'),
    join(dir, PREVIEW_PLAYLIST),
  ], { maxBuffer: 1024 * 1024 * 32 })

  await stampPlaylist(dir)
}

/**
 * 给索引里的每个分段挂上【按内容算的】版本号:`seg-0000.ts?v=a3f91c2b`。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────
 * 分段是【按位置】命名的,不是按内容:seg-0000.ts 永远叫这个名字,而母带
 * 一重烧,同一个 URL back 的就是【不同的字节】。而分段是按 `immutable`
 * 长缓存发出去的(见 queue/routes.ts)——浏览器根本不会再问服务器。
 *
 * 于是:重烧完,盘上是新的,索引是新的,用户看到的还是【旧画面】。
 * 真踩过一次:重选开头之后,下载下来是对的、封面是对的,唯独预览里
 * 开头没变——因为换头只改了第一个分段的字节,后面几十个分段本来就一样,
 * 缓存里那份旧的 seg-0000.ts 就是唯一错的东西。
 *
 * ── 为什么按内容而不是按母带指纹 ────────────────────────────────────
 * 挂一个整份的版本号(?v=母带指纹)一行就能写完,但那样【每个】分段都会
 * 失效。9 分半的片子预览约 70MB,而她那条跨洲的线只有几百 KB/s。
 * 按内容算的话,换开头只有第一个分段变,后面几十个继续命中缓存。
 *
 * 哈希只在【生成预览时】算一次,不在每次请求时算。
 */
async function stampPlaylist (dir: string): Promise<void> {
  const path = join(dir, PREVIEW_PLAYLIST)
  const text = await readFile(path, 'utf-8')
  const out: string[] = []
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (/^seg-\d{4}\.ts$/.test(name)) {
      const buf = await readFile(join(dir, name))
      out.push(`${name}?v=${createHash('sha1').update(buf).digest('hex').slice(0, 8)}`)
    } else {
      out.push(line)
    }
  }
  await writeFile(path, out.join('\n'), 'utf-8')
}

/** 预览一共占多少字节。给归档统计用 */
export async function previewSize (assetDirPath: string): Promise<number> {
  const dir = previewDir(assetDirPath)
  let total = 0
  try {
    const { stat } = await import('node:fs/promises')
    for (const f of await readdir(dir)) {
      try { total += (await stat(join(dir, f))).size } catch { /* 忽略 */ }
    }
  } catch { /* 没有预览 */ }
  return total
}
