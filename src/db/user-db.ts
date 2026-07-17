import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { userDbDir } from '../auth/whitelist.js'

export interface UserDb {
  raw: Database.Database
  path: string
  close (): void
}

/**
 * 打开某用户的独立数据库。
 *
 * ⚠️ 物理隔离的核心：函数签名【只收 name + 白名单】，绝不收 path。
 * 打开哪个文件由 userDbDir(name) 经白名单映射唯一确定，外部无法注入路径。
 * 这就是为什么整个项目里【不存在 WHERE owner = ?】——打开的库本身就是那个人的，
 * "某处查询忘了加过滤"这类泄露在结构上不可能发生（设计文档第 3 节）。
 *
 * schema 按设计文档第 4 节建好（projects 等表），但 CRUD 留给阶段 3
 * 与前端一起做——现在建 CRUD 是在凭空猜前端需要什么。
 */
export function openUserDb (name: string, whitelist: string[]): UserDb {
  const dir = userDbDir(name, whitelist)   // 先过白名单，防路径穿越
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'app.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  // schema：设计文档第 4 节。CRUD 留给阶段 3。
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      script_text TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '9:16',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  return { raw: db, path, close () { db.close() } }
}
