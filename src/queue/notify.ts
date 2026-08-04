import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb } from '../db/user-db.js'
import { assetDir } from '../assets/storage.js'
import { FILM_FILE } from '../compose/film.js'

/**
 * 「有哪些片子刚做完」——给 app 的后台轮询用。
 *
 * ── 为什么不让 app 自己逐个项目问 ────────────────────────────────────
 * 后台任务醒来一次要尽快问完就睡，逐个项目打 /film 是 N 次请求，而且
 * /film 会顺手补合、算指纹，比这重得多。这里一次问完，只做 N 次 stat。
 *
 * ── 为什么用「成片的修改时间」而不是另存一份完成记录 ─────────────────
 * export.mp4 落盘那一刻就是这条片子做完的时刻，它已经是事实本身。
 * 另存一张"完成事件表"意味着两处状态要保持一致——而它们迟早会不一致
 * （删了成片、手工重烧、进程被杀），到时候通知说做完了、点进去没有片子。
 *
 * ⚠️ 时间戳由客户端带上来（它记着自己上次看到哪儿），服务端不存"已读"。
 * 多设备各看各的，互不干扰；服务端也不必为"谁读过了"这种事负责。
 */
export interface FinishedFilm {
  projectId: string
  name: string
  /** 成片落盘的时刻（毫秒）。客户端拿最大值当下次的 since */
  finishedAt: number
}

export async function finishedSince (
  userName: string, whitelist: string[], sinceMs: number,
): Promise<FinishedFilm[]> {
  const db = openUserDb(userName, whitelist)
  let projects
  try {
    projects = db.listProjects()
  } finally {
    db.close()
  }

  const out: FinishedFilm[] = []
  for (const p of projects) {
    const film = join(assetDir(userName, whitelist, p.id), FILM_FILE)
    try {
      const st = await stat(film)
      const at = Math.floor(st.mtimeMs)
      if (at > sinceMs) out.push({ projectId: p.id, name: p.name, finishedAt: at })
    } catch {
      // 没有成片：还没烧完、或者被删了。都不是"刚做完"
    }
  }
  return out.sort((a, b) => a.finishedAt - b.finishedAt)
}
