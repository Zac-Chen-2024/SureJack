import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { libraryRoot, libraryItemPath } from './paths.js'
import type { LibraryItem } from '../compose/plan.js'

const run = promisify(execFile)

/** 缩略图宽度。手机上一行铺三个，216 够清楚又不至于让 68 张图撑爆流量 */
const THUMB_W = 216

/**
 * 抽第几毫秒那一帧。
 *
 * ⚠️【不能抽第 0 帧】。剪辑软件导出的片子开头常常是一帧纯黑或者转场，
 * 68 个素材摆出来会有一片黑格子，等于没有缩略图。往里挪 1 秒就避开了；
 * 比 1 秒还短的素材退回到中点。
 */
function grabAtMs (durationMs: number): number {
  return durationMs > 2000 ? 1000 : Math.max(0, Math.floor(durationMs / 2))
}

/**
 * 缩略图落在哪儿。
 *
 * ⚠️【文件名走哈希，不直接用素材文件名】。素材名是中文、带空格、带各种
 * 括号的真实文件名，再拼上 .jpg 当路径，等于把一个外部字符串塞进路径里。
 * 哈希之后这一层完全没有路径穿越的余地，也不用操心大小写和长度上限。
 */
export function thumbPath (dataDir: string, item: { bucket: string; filename: string }): string {
  const key = createHash('sha256').update(`${item.bucket}/${item.filename}`).digest('hex').slice(0, 32)
  return resolve(join(libraryRoot(dataDir), '_thumbs', `${key}.jpg`))
}

/**
 * 确保这条素材的缩略图存在，返回它的路径。
 *
 * 已经有了就直接返回，不重跑 ffmpeg——68 个素材每次进挑选页都重抽一遍，
 * 手机上要等好几秒，而这些素材是不会变的。
 */
export async function ensureThumb (
  dataDir: string, item: LibraryItem,
): Promise<string> {
  const out = thumbPath(dataDir, item)
  try {
    await stat(out)
    return out
  } catch {
    // 没有就生成
  }
  await mkdir(join(libraryRoot(dataDir), '_thumbs'), { recursive: true })
  const src = libraryItemPath(dataDir, item)
  /*
   * -ss 放在 -i 【前面】：这样 ffmpeg 直接跳到关键帧再解码，
   * 放后面是从头解到那一秒。开头素材只有几十秒无所谓，
   * 但同一个函数将来也可能被拿去抽 GB 级的跑酷素材，那时差距是几十倍。
   */
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(grabAtMs(item.durationMs) / 1000),
    '-i', src,
    '-frames:v', '1',
    '-vf', `scale=${THUMB_W}:-2`,
    '-q:v', '4',
    out,
  ])
  return out
}

/**
 * 一个桶的缩略图全部备好。
 *
 * ⚠️【串行，不并发】。68 个 ffmpeg 一起上会把这台机器的 CPU 吃光，
 * 而烧录队列正跑在同一台机器上——用户会看到进度条卡住十几秒。
 * 一张几十毫秒，串行跑完也就两三秒。
 *
 * 失败的那条【跳过，不中断】：某个素材文件损坏不该让整个桶备不出图。
 */
export async function warmThumbs (
  dataDir: string, items: readonly LibraryItem[],
): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (const it of items) {
    try {
      await ensureThumb(dataDir, it)
      ok++
    } catch {
      failed++
    }
  }
  return { ok, failed }
}
