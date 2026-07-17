import Database from 'better-sqlite3'
import { hashPassword, verifyPassword } from '../auth/password.js'

export interface AuthDb {
  hasPassword (name: string): boolean
  setPassword (name: string, plain: string, ip: string): Promise<void>
  checkPassword (name: string, plain: string): Promise<boolean>
  getFirstLoginInfo (name: string): { createdAt: string; ip: string } | null
  close (): void
}

/**
 * 打开认证库。这是唯一的共享库——只存密码哈希，不含任何项目数据。
 * 密码重置 CLI 也只碰这一个文件。
 */
export function openAuthDb (path: string): AuthDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      first_login_ip TEXT NOT NULL
    )
  `)

  return {
    hasPassword (name) {
      return db.prepare('SELECT 1 FROM users WHERE name = ?').get(name) !== undefined
    },

    async setPassword (name, plain, ip) {
      const hash = await hashPassword(plain)
      const existing = db.prepare('SELECT created_at, first_login_ip FROM users WHERE name = ?').get(name) as
        { created_at: string; first_login_ip: string } | undefined
      if (existing) {
        // 重置：只改哈希，保留首登记录（首登 IP 是抢注证据）
        db.prepare('UPDATE users SET password_hash = ? WHERE name = ?').run(hash, name)
      } else {
        // 首次：记录时间和 IP。用 ISO 字符串（Date 在测试里可用，非生产热路径）
        const now = new Date().toISOString()
        db.prepare('INSERT INTO users (name, password_hash, created_at, first_login_ip) VALUES (?, ?, ?, ?)')
          .run(name, hash, now, ip)
      }
    },

    async checkPassword (name, plain) {
      const row = db.prepare('SELECT password_hash FROM users WHERE name = ?').get(name) as
        { password_hash: string } | undefined
      if (!row) return false
      return verifyPassword(plain, row.password_hash)
    },

    getFirstLoginInfo (name) {
      const row = db.prepare('SELECT created_at, first_login_ip FROM users WHERE name = ?').get(name) as
        { created_at: string; first_login_ip: string } | undefined
      return row ? { createdAt: row.created_at, ip: row.first_login_ip } : null
    },

    close () { db.close() },
  }
}
