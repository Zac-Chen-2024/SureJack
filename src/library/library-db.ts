import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { libraryRoot } from './paths.js'

/** 一条素材。id 是稳定引用——项目只存 id，绝不复制素材文件。 */
export interface LibraryItem {
  id: string
  bucket: string
  filename: string
  durationMs: number
  sizeBytes: number
}

export interface LibraryDb {
  raw: Database.Database
  path: string
  close (): void
}

/** SQLite 行 → LibraryItem（列名 snake_case，对外 camelCase） */
export const toLibraryItem = (r: Record<string, unknown>): LibraryItem => ({
  id: r.id as string,
  bucket: r.bucket as string,
  filename: r.filename as string,
  durationMs: r.duration_ms as number,
  sizeBytes: r.size_bytes as number,
})

/**
 * 打开全站唯一的素材索引库 data/library/library.db。
 *
 * ⚠️ 与 openUserDb 有意不同：签名里【没有用户名也没有白名单】。
 * 素材库是全局公用的，不属于任何用户，不经过 userDbDir()。
 *
 * 【一个目录只能有一份索引】——绝不要把 library_items 塞进用户的 app.db：
 * 那样两个用户各扫同一个目录，一人上传后另一人的索引就是陈旧的，
 * 而且两份索引会各自生成不同的 id 指向同一个文件，引用就此错位。
 */
export function openLibraryDb (dataDir: string): LibraryDb {
  const dir = libraryRoot(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'library.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  // 全新的库文件，建表可直接用 IF NOT EXISTS。
  // 但【将来给它加列时】必须走 PRAGMA table_info + ALTER TABLE：
  // CREATE TABLE IF NOT EXISTS 对已存在的表不生效，本项目已经踩过一次。
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_items (
      id          TEXT PRIMARY KEY,
      bucket      TEXT NOT NULL,
      filename    TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      size_bytes  INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (bucket, filename)
    );
  `)

  return {
    raw: db,
    path,
    close () { db.close() },
  }
}
