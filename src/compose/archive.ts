import { rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openUserDb } from '../db/user-db.js'
import { assetDir } from '../assets/storage.js'
import { userDbDir } from '../auth/whitelist.js'
import { FILM_MASTER_FILE } from './film.js'
import { BG_TRACK_FILE } from './prebuild.js'
import { PREVIEW_DIR } from './preview.js'

/**
 * 归档：把久未使用的项目"压缩"成一份索引 + 参数 + 配音。
 *
 * ── 为什么值得做 ────────────────────────────────────────────────────
 * 实测一条十分钟的片子在盘上是这样的：
 *     bg-track.mp4   530–630 MB   ← 可重算（三段式排布是确定性的）
 *     master.mp4     600–730 MB   ← 可重烧（画面 + 字幕，输入都在库里）
 *     voice.mp3        8–9  MB    ← ⚠️ 不可重来
 * 也就是【1.3 GB 里有 1.29 GB 是可以再算出来的】。删掉它们，项目从 1.3GB
 * 变成 9MB——省掉 99.3%，而且一个字节的用户数据都没丢。
 *
 * ── 为什么配音必须留 ────────────────────────────────────────────────
 * 重新合成配音会拿到【不同的词级时间戳】：字幕的每一行都是从时间戳推的，
 * 所以字幕会整体错位。而且要再烧一次 Azure 配额。
 * 留 9MB 换"逐帧一致的复原"，太划算了。
 *
 * ── "无损"是有前提的，而且这个前提已经成立 ──────────────────────────
 * 背景排布在用户敲定开头时就【物化成一份具体清单】存进库（不是每次现算），
 * 字幕从库里的词级时间戳推，配音文件原样留着——所以复原出来的片子和原来
 * 逐帧一致。要是排布还是"拿项目 id 当种子现算"，素材库一变就复原不出来了。
 */

/**
 * 归档时删掉的那些：全都能从库里的数据重新算出来。
 *
 * ⚠️【`master.json` 故意留着】。它才 145 字节，而里面的母带指纹是
 * 【待取成片指纹】的一部分（见 deliver.ts 的 deliverTag）。删了的话，
 * 已归档项目盘上那份还没被取走的成片就算不出指纹、认不出身份，
 * 开机清扫又会退回到"分辨不出就一律删"的老路上——那正是 review #13。
 *
 * 留着它不会让母带被误判成"还在"：reusableOutput 同时要求指纹匹配
 * 【和文件存在且非空】，而 master.mp4 已经删了。
 */
/*
 * ⚠️【必须是函数，不能是模块顶层的常量数组】。
 *
 * 这里有一条循环引用：film.ts → disk-guard.ts → archive.ts → film.ts。
 * 写成顶层 `const REGENERABLE = [FILM_MASTER_FILE, ...]` 的话，archive.ts
 * 初始化时 film.ts 还没初始化完，取 FILM_MASTER_FILE 会撞上 TDZ：
 *   ReferenceError: Cannot access 'FILM_MASTER_FILE' before initialization
 * 而且它是【模块加载期】就炸，整个服务起不来——表现是所有导出请求 500。
 *
 * 改成函数之后，取值发生在【调用时】，那时两个模块都早就初始化好了。
 */
const regenerable = (): string[] => [FILM_MASTER_FILE, BG_TRACK_FILE, 'export.json']
/** 预览分段整目录删——它是从母带算出来的，母带都删了它更留不住 */
const REGENERABLE_DIRS = [PREVIEW_DIR]

/** 多久没动过就收起来 */
export const ARCHIVE_AFTER_MS = 2 * 60 * 60 * 1000

export interface ArchiveResult {
  projectId: string
  name: string
  freedBytes: number
}

/** 这条项目现在归档了吗（库里标了、而且母带确实不在了） */
export function isArchived (archivedAt: string, dir: string): boolean {
  return archivedAt !== '' && !existsSync(join(dir, FILM_MASTER_FILE))
}

/**
 * 归档一条项目：删掉可重算的大文件，标上时间。
 * 库里的东西一个字段都不动——那才是复原的依据。
 */
export async function archiveProject (
  userName: string, whitelist: string[], projectId: string,
): Promise<number> {
  const dir = assetDir(userName, whitelist, projectId)
  let freed = 0
  for (const f of regenerable()) {
    const p = join(dir, f)
    try {
      freed += (await stat(p)).size
      await rm(p, { force: true })
    } catch { /* 本来就没有 */ }
  }
  for (const d of REGENERABLE_DIRS) {
    const p = join(dir, d)
    try {
      for (const f of await readdir(p)) {
        try { freed += (await stat(join(p, f))).size } catch { /* 忽略 */ }
      }
      await rm(p, { recursive: true, force: true })
    } catch { /* 本来就没有 */ }
  }
  const db = openUserDb(userName, whitelist)
  try {
    db.updateProject(projectId, { archivedAt: new Date().toISOString() })
  } finally {
    db.close()
  }
  return freed
}

/**
 * 扫一遍，把"下载过、而且两小时没动过"的收起来。
 *
 * ⚠️【只收下载过的】。没下载过说明还没定稿——把用户正在打磨的东西收走，
 * 他下次进来要等十几分钟才能继续看，那是帮倒忙。
 *
 * ⚠️【"没动过"按 touchedAt 算，不是 updatedAt】。updatedAt 只在改了内容时
 * 才动，而"打开看了一眼"也算动过；按 updatedAt 的话，天天在看但没改过的
 * 片子会被收起来。
 */
export async function sweepArchive (
  whitelist: string[], now = Date.now(),
): Promise<ArchiveResult[]> {
  const out: ArchiveResult[] = []
  for (const user of whitelist) {
    const db = openUserDb(user, whitelist)
    let rows
    try { rows = db.listProjects() } finally { db.close() }
    for (const p of rows) {
      if (p.archivedAt !== '') continue                  // 已经收起来了
      if (p.downloadedAt === '') continue                // 没下载过 = 还没定稿
      const touched = Date.parse(p.touchedAt || p.updatedAt)
      if (!Number.isFinite(touched)) continue
      if (now - touched < ARCHIVE_AFTER_MS) continue
      const dir = assetDir(user, whitelist, p.id)
      if (!existsSync(join(dir, FILM_MASTER_FILE))) continue   // 没东西可收
      const freed = await archiveProject(user, whitelist, p.id)
      out.push({ projectId: p.id, name: p.name, freedBytes: freed })
    }
  }
  return out
}

/**
 * 清掉【孤儿素材目录】：项目已经删了，文件还躺在盘上。
 *
 * 实测线上就有一个这样的目录白占 1.34 GB。删项目的路由是会一起删文件的，
 * 但历史上有过删了库行没删文件的路径（早期版本、手工操作），
 * 而这种垃圾没有任何东西会来认领它。
 */
export async function sweepOrphanAssets (whitelist: string[]): Promise<number> {
  let freed = 0
  for (const user of whitelist) {
    const root = join(userDbDir(user, whitelist), 'assets')
    let dirs: string[]
    try { dirs = await readdir(root) } catch { continue }
    const db = openUserDb(user, whitelist)
    let live: Set<string>
    try { live = new Set(db.listProjects().map((p) => p.id)) } finally { db.close() }
    for (const d of dirs) {
      if (live.has(d)) continue
      const full = join(root, d)
      try {
        for (const f of await readdir(full)) {
          try { freed += (await stat(join(full, f))).size } catch { /* 忽略 */ }
        }
        await rm(full, { recursive: true, force: true })
      } catch { /* 删不掉就下次再说 */ }
    }
  }
  return freed
}
