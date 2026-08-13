import { statfs } from 'node:fs/promises'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { openUserDb } from '../db/user-db.js'
import { assetDir } from '../assets/storage.js'
import { archiveProject } from './archive.js'
import { FILM_MASTER_FILE } from './film.js'
import { PREVIEW_DIR } from './preview.js'

/**
 * 磁盘不够时怎么腾地方。
 *
 * ── 原则（用户定的）────────────────────────────────────────────────
 * **磁盘压力只用「可重算的东西」化解，永远不动用户还没拿到手的成品。**
 *
 * 一条片子在盘上的东西按性质分三类：
 *   · 母带 + 预览  ~520MB   【可重算】→ 磁盘紧张时第一个牺牲（= 归档）
 *   · 待取成片      ~458MB  【用户的成品】→ 没下载走就一直留着，谁都不许删
 *   · 配音            6MB   【不可重算】（重配音会拿到不同的词级时间戳，
 *                            字幕全部错位）→ 永远留着
 *
 * ── 两步回收 ────────────────────────────────────────────────────────
 *   ① 先找「已经下载过、但还没到两小时归档阈值」的项目，**提前归档**。
 *      用户已经把成品拿走了，剩下的全是可重算的，删了不丢任何东西。
 *   ② 还不够 → 说明空间被「合成好了但用户还没下载」的片子占着。
 *      **这时候不能删** —— 那是他要的东西。改成告诉他：
 *      「先把《XX》下载了，腾出空间才能继续合成」。
 *      他下完之后自动归档、被卡住的合成自动继续。
 *
 * ⚠️ 第 ① 步的正确性【依赖 downloadedAt 的语义】：只有真正传完最后一个
 * 字节才写。要是还是老的"开始传就写"，这一步会把用户根本没下成的项目
 * 归档掉——那份母带一没，他就得等十几分钟重烧。
 */

/**
 * 盘上还剩多少字节。**读不出来返回 null，绝不抛。**
 *
 * ⚠️ statfs 对【还不存在的目录】会抛 ENOENT——而项目的素材目录是在真正
 * 写第一个文件时才建的，入队预检跑在那之前。测试里当场 500 了一片。
 * 目录不在就往上找一层，一直找到数据根目录；还是不行就返回 null。
 *
 * 【一个读不出磁盘的检查，绝不能因此挡住用户。】不确定就放行——
 * 真的不够，后面 ffmpeg 会失败，那是可恢复的；而误挡是直接不能用。
 */
export async function freeBytes (path: string): Promise<number | null> {
  let p = resolve(path)
  for (let i = 0; i < 6; i++) {
    try {
      const s = await statfs(p)
      return s.bavail * s.bsize
    } catch {
      const up = dirname(p)
      if (up === p) break
      p = up
    }
  }
  return null
}

/**
 * 一次合成大概要留多少空间。
 *
 * 背景轨 + 母带各一份，再加一点富余。宁可估多——估少的后果是 ffmpeg
 * 一路写到 No space left 才失败，那时它已经占了几百 MB，
 * 而报出来的错和"磁盘"这两个字离得很远（踩过：症状是 502）。
 */
export const COMPOSE_NEED_BYTES = 2 * 1024 * 1024 * 1024

export interface Reclaimable {
  user: string
  projectId: string
  name: string
  /** 归档这条能腾出多少字节（母带 + 预览） */
  bytes: number
  /** 下载完成时间，早的先归档 */
  downloadedAt: string
}

/** 每条项目归档能腾多少（母带 + 预览目录） */
function reclaimableBytes (dir: string): number {
  let n = 0
  try {
    const m = join(dir, FILM_MASTER_FILE)
    if (existsSync(m)) n += statSync(m).size
  } catch { /* 算不出就当 0 */ }
  try {
    const p = join(dir, PREVIEW_DIR)
    if (existsSync(p)) {
      for (const f of readdirSync(p)) {
        try { n += statSync(join(p, f)).size } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
  return n
}

/**
 * 「已经下载过、但还没到归档阈值」的项目 —— 第一步能回收的就是这些。
 * 按下载时间从早到晚排：先收最久以前拿走的那条。
 */
export function reclaimable (whitelist: string[]): Reclaimable[] {
  const out: Reclaimable[] = []
  for (const u of whitelist) {
    let rows
    try {
      const db = openUserDb(u, whitelist)
      try { rows = db.listProjects() } finally { db.close() }
    } catch { continue }
    for (const p of rows) {
      if (p.downloadedAt === '') continue     // 还没拿走 → 不能动
      if (p.archivedAt !== '') continue       // 已经收起来了
      const dir = assetDir(u, whitelist, p.id)
      const bytes = reclaimableBytes(dir)
      if (bytes <= 0) continue
      out.push({ user: u, projectId: p.id, name: p.name, bytes, downloadedAt: p.downloadedAt })
    }
  }
  out.sort((a, b) => a.downloadedAt.localeCompare(b.downloadedAt))
  return out
}

/**
 * 「合成好了但用户还没下载」的项目 —— 空间被它们占着，而**不能删**。
 * 第二步要把这些报给用户，让他去下载。
 */
export function undownloaded (whitelist: string[]): Array<{
  user: string, projectId: string, name: string, bytes: number
}> {
  const out = []
  for (const u of whitelist) {
    let rows
    try {
      const db = openUserDb(u, whitelist)
      try { rows = db.listProjects() } finally { db.close() }
    } catch { continue }
    for (const p of rows) {
      if (p.downloadedAt !== '') continue     // 已经拿走了
      if (p.archivedAt !== '') continue
      const dir = assetDir(u, whitelist, p.id)
      if (!existsSync(join(dir, FILM_MASTER_FILE))) continue   // 还没合成好
      out.push({ user: u, projectId: p.id, name: p.name, bytes: reclaimableBytes(dir) })
    }
  }
  out.sort((a, b) => b.bytes - a.bytes)       // 占得多的排前面，先下它最划算
  return out
}

export interface ReclaimResult {
  /** 腾够了吗 */
  ok: boolean
  freed: number
  free: number
  /** 提前归档了哪几条 */
  archived: Array<{ name: string, bytes: number }>
  /** ok=false 时：建议用户先下载哪几条（空间被它们占着，但不能删） */
  suggest: Array<{ projectId: string, name: string, bytes: number }>
}

/**
 * 腾空间。**只归档，不删任何用户还没拿到手的东西。**
 *
 * @param need 至少要腾到还剩这么多字节
 */
export async function reclaim (
  whitelist: string[], rootPath: string, need = COMPOSE_NEED_BYTES,
): Promise<ReclaimResult> {
  const initial = await freeBytes(rootPath)
  // 读不出磁盘 → 放行。不确定的时候挡住用户是最糟的选择
  if (initial === null) {
    return { ok: true, freed: 0, free: Number.MAX_SAFE_INTEGER, archived: [], suggest: [] }
  }
  let free = initial
  if (free >= need) {
    return { ok: true, freed: 0, free, archived: [], suggest: [] }
  }

  const archived: Array<{ name: string, bytes: number }> = []
  let freed = 0
  for (const c of reclaimable(whitelist)) {
    if (free >= need) break
    try {
      const n = await archiveProject(c.user, whitelist, c.projectId)
      freed += n
      free += n
      archived.push({ name: c.name, bytes: n })
    } catch { /* 这条归不了档就试下一条 */ }
  }

  if (free >= need) return { ok: true, freed, free, archived, suggest: [] }

  return {
    ok: false, freed, free, archived,
    suggest: undownloaded(whitelist).map((u) => ({
      projectId: u.projectId, name: u.name, bytes: u.bytes,
    })),
  }
}

/** 说人话的 GB */
export function gb (n: number): string {
  return (n / 1024 / 1024 / 1024).toFixed(1)
}

/**
 * 卡住时给用户看的话。**必须能照着做**——只说"磁盘不足"等于没说。
 */
export function blockedMessage (r: ReclaimResult): string {
  const short = gb(COMPOSE_NEED_BYTES - r.free)
  if (r.suggest.length === 0) {
    return `磁盘空间不够（还差约 ${short}G），而且没有可以回收的项目了。请联系开发人员。`
  }
  const first = r.suggest[0]!
  return `磁盘空间不够（还差约 ${short}G）。`
    + `先把《${first.name}》下载完就能腾出 ${gb(first.bytes)}G，`
    + '下完会自动继续合成。'
}
