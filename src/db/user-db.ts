import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { userDbDir } from '../auth/whitelist.js'

/** 一个项目。核心是 scriptText——设计文档：项目的核心是文字 */
export interface Project {
  id: string
  name: string
  scriptText: string
  aspectRatio: string
  createdAt: string
  updatedAt: string
}

export interface UserDb {
  raw: Database.Database
  path: string
  listProjects (): Project[]
  getProject (id: string): Project | null
  createProject (name: string): Project
  updateProject (id: string, patch: { name?: string; scriptText?: string; aspectRatio?: string }): Project | null
  deleteProject (id: string): boolean
  close (): void
}

/** SQLite 行 → Project（列名 snake_case，对外 camelCase） */
interface Row {
  id: string; name: string; script_text: string
  aspect_ratio: string; created_at: string; updated_at: string
}
const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, scriptText: r.script_text,
  aspectRatio: r.aspect_ratio, createdAt: r.created_at, updatedAt: r.updated_at,
})

/**
 * 打开某用户的独立数据库。
 *
 * ⚠️ 物理隔离的核心：函数签名【只收 name + 白名单】，绝不收 path。
 * 打开哪个文件由 userDbDir(name) 经白名单映射唯一确定，外部无法注入路径。
 * 这就是为什么整个项目里【不存在 WHERE owner = ?】——打开的库本身就是那个人的。
 */
export function openUserDb (name: string, whitelist: string[]): UserDb {
  const dir = userDbDir(name, whitelist)   // 先过白名单，防路径穿越
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'app.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

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

  return {
    raw: db,
    path,

    listProjects () {
      const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]
      return rows.map(toProject)
    },

    getProject (id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      return row ? toProject(row) : null
    },

    createProject (projectName) {
      const now = new Date().toISOString()
      const project: Project = {
        id: randomUUID(), name: projectName, scriptText: '',
        aspectRatio: '9:16', createdAt: now, updatedAt: now,
      }
      db.prepare(
        'INSERT INTO projects (id, name, script_text, aspect_ratio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(project.id, project.name, project.scriptText, project.aspectRatio, now, now)
      return project
    },

    updateProject (id, patch) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      if (!row) return null
      const now = new Date().toISOString()
      // 部分更新：没传的字段保持原值
      db.prepare(
        'UPDATE projects SET name = ?, script_text = ?, aspect_ratio = ?, updated_at = ? WHERE id = ?'
      ).run(
        patch.name ?? row.name,
        patch.scriptText ?? row.script_text,
        patch.aspectRatio ?? row.aspect_ratio,
        now, id,
      )
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row
      return toProject(updated)
    },

    deleteProject (id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return info.changes > 0
    },

    close () { db.close() },
  }
}
