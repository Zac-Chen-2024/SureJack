import { spawn } from 'node:child_process'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { libraryRoot, bucketDir, isBucket } from './paths.js'

/**
 * 把素材库里的视频统一转成成片规格，导出时就不用每次现转。
 *
 * ── 为什么值得做 ────────────────────────────────────────────────
 * 素材库里没有一个文件是目标规格：
 *   1-开头 / 2-常规   720x1280   要放大
 *   3-地铁跑酷        1844x4096  要缩小（这几个 1GB 的就是因为这个）
 *
 * 实测代价：从 4K 跑酷素材截 10 秒要花 45 秒——【比实时还慢 4.5 倍】。
 * 一条 11.5 分钟的片子里跑酷占 46%，光这部分就要 24 分钟，
 * 而且每导出一次就重付一遍。
 *
 * 转一次之后，切片就只是"同规格解码 + 编码"，缩放和裁切都变成恒等操作。
 *
 * ── 为什么不直接覆盖原文件 ──────────────────────────────────────
 * 原素材是用户的，转码是有损的。产物放 `_normalized/` 下另存一份，
 * 原文件一个字节都不动。取用时优先用转好的，没有就退回原文件——
 * 所以这一步【随时可以中断】，转多少算多少，不会让系统处于半坏状态。
 */

/** 成片规格。与 ASPECT_PRESETS['9:16'] 一致——那是唯一在用的画幅。 */
export const TARGET = { width: 1080, height: 1920, fps: 30 } as const

/** 转好的素材放这里，与四个桶平级 */
export function normalizedDir (dataDir: string): string {
  return join(libraryRoot(dataDir), '_normalized')
}

/**
 * 某个素材转码后的路径。
 *
 * ⚠️ 桶名仍要过 `isBucket`——`_normalized` 目录在 library 根下，
 * 拼路径的规矩和桶目录一样，不能因为多了一层就绕开白名单。
 */
export function normalizedPath (dataDir: string, bucket: string, filename: string): string {
  if (!isBucket(bucket)) throw new Error(`未知的素材桶：${bucket}`)
  return join(normalizedDir(dataDir), bucket, filename)
}

/** 转好的存在就用它，否则退回原文件。取用方只调这一个函数。 */
export async function resolveSource (
  dataDir: string, bucket: string, filename: string,
): Promise<string> {
  const norm = normalizedPath(dataDir, bucket, filename)
  try {
    const s = await stat(norm)
    if (s.size > 0) return norm
  } catch { /* 没转过，走原文件 */ }
  return join(bucketDir(dataDir, bucket), filename)
}

function run (args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args)
    let err = ''
    ff.stderr.on('data', (d) => { err += String(d) })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`))
    })
  })
}

export interface NormalizeResult {
  /** 本次真正转了几个 */
  converted: number
  /** 已经转过、跳过的 */
  skipped: number
  /** 转失败的文件名（不中断整轮） */
  failed: string[]
}

/**
 * 把一个桶里的素材全部转成目标规格。
 *
 * 幂等：已经转过的跳过，所以中断后重跑只补没转的。
 *
 * 【先写临时文件再改名】：转码中途被杀会留下半个文件，而半个 mp4
 * 的 size > 0，下次 resolveSource 会当它是好的直接用，成片就毁了。
 * rename 在同一分区上是原子的，要么没有要么完整。
 */
export async function normalizeBucket (
  dataDir: string, bucket: string, files: readonly string[],
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<NormalizeResult> {
  const outDir = join(normalizedDir(dataDir), bucket)
  await mkdir(outDir, { recursive: true })

  const res: NormalizeResult = { converted: 0, skipped: 0, failed: [] }
  let done = 0

  for (const filename of files) {
    const out = join(outDir, filename)
    try {
      const s = await stat(out)
      if (s.size > 0) { res.skipped++; done++; onProgress?.(done, files.length, filename); continue }
    } catch { /* 没转过 */ }

    const src = join(bucketDir(dataDir, bucket), filename)
    const tmp = `${out}.partial.mp4`
    await mkdir(dirname(tmp), { recursive: true })
    try {
      await run([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        // cover：铺满画幅再居中裁切。素材宽高比五花八门，留黑边不好看
        '-vf', `scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=increase,` +
               `crop=${TARGET.width}:${TARGET.height},fps=${TARGET.fps},setsar=1`,
        '-an',                       // 背景一律静音，音轨白占体积
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        // 每秒一个关键帧：切片时 -ss 能落在更近的关键帧上，
        // 将来若改成 -c copy 直接拷贝切片，这是前提
        '-g', String(TARGET.fps),
        '-movflags', '+faststart',
        tmp,
      ])
      await rename(tmp, out)
      res.converted++
    } catch {
      res.failed.push(filename)
    }
    done++
    onProgress?.(done, files.length, filename)
  }
  return res
}
