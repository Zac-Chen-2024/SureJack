import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isAllowedExt } from '../assets/storage.js'
import type { AssetKind } from '../db/user-db.js'
import { probeDurationMs } from '../render/probe.js'
import { bucketDir, isBucket } from './paths.js'
import { toLibraryItem, type LibraryDb, type LibraryItem } from './library-db.js'

/**
 * 桶里装的是哪一类文件。三个视频桶 + 一个音乐桶。
 * 扫描据此决定认哪些扩展名——背景音乐桶里混进来的 mp4 不该入库。
 */
function bucketKind (bucket: string): AssetKind {
  return bucket === '背景音乐' ? 'bgm' : 'video'
}

/**
 * 扫描某个桶的目录，把新出现的素材写进索引。
 *
 * ⚠️ 桶名先过白名单——素材库不经过 userDbDir()，isBucket 是唯一一道闸。
 *
 * 幂等：靠 UNIQUE (bucket, filename)，重复扫描不产生重复行，
 * 也不会给同一个文件换新 id（项目只存 id 引用，换 id 会把引用打断）。
 */
export async function scanBucket (
  db: LibraryDb, dataDir: string, bucket: string,
): Promise<{ added: number; total: number }> {
  const dir = bucketDir(dataDir, bucket)   // 先查白名单，防穿越
  const kind = bucketKind(bucket)

  // 目录还没建（素材尚未导入）不算错误，当作空桶
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { added: 0, total: countBucket(db, bucket) }
  }

  // 已在库里的文件跳过——不重新 ffprobe。地铁跑酷桶里是 GB 级文件，
  // 每次重扫都重探一遍纯属浪费。
  const known = new Set(
    (db.raw.prepare('SELECT filename FROM library_items WHERE bucket = ?').all(bucket) as
      { filename: string }[]).map((r) => r.filename)
  )

  const insert = db.raw.prepare(
    `INSERT OR IGNORE INTO library_items
      (id, bucket, filename, duration_ms, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`
  )

  let added = 0
  for (const filename of names.sort()) {
    if (known.has(filename)) continue
    if (!isAllowedExt(filename, kind)) continue     // 只处理已知扩展名，其余跳过

    const full = join(dir, filename)
    let durationMs: number
    let sizeBytes: number
    try {
      const st = await stat(full)
      if (!st.isFile()) continue                     // 子目录不递归
      sizeBytes = st.size
      // ffprobe 只读元数据不解码，即使 1GB 文件也在毫秒级，不必并发
      durationMs = await probeDurationMs(full)
    } catch (e) {
      // 单个文件损坏【不能中断整轮扫描】——素材包里坏文件是常态
      console.warn(`素材探测失败，已跳过：${full}\n${(e as Error).message}`)
      continue
    }

    const info = insert.run(randomUUID(), bucket, filename, durationMs, sizeBytes, new Date().toISOString())
    if (info.changes > 0) added += 1
  }

  return { added, total: countBucket(db, bucket) }
}

/** 列出某个桶里已入库的素材，按文件名排序（顺序稳定，排布算法依赖它） */
export function listBucket (db: LibraryDb, bucket: string): LibraryItem[] {
  if (!isBucket(bucket)) throw new Error(`未知的素材桶：${bucket}`)
  const rows = db.raw.prepare(
    'SELECT * FROM library_items WHERE bucket = ? ORDER BY filename'
  ).all(bucket) as Record<string, unknown>[]
  return rows.map(toLibraryItem)
}

function countBucket (db: LibraryDb, bucket: string): number {
  const row = db.raw.prepare(
    'SELECT COUNT(*) AS n FROM library_items WHERE bucket = ?'
  ).get(bucket) as { n: number }
  return row.n
}
