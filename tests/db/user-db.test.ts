import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'
import { rmSync } from 'node:fs'

const LIST = ['张三', '李四']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

describe('user-db —— 物理隔离', () => {
  it('打开的库路径包含用户名', () => {
    const db = openUserDb('张三', LIST); dbs.push(db)
    expect(db.path).toContain('张三')
  })

  it('两个用户的库是不同文件——物理隔离', () => {
    const a = openUserDb('张三', LIST); dbs.push(a)
    const b = openUserDb('李四', LIST); dbs.push(b)
    expect(a.path).not.toBe(b.path)
  })

  it('名单外用户无法打开库——路径映射先过白名单', () => {
    expect(() => openUserDb('王五', LIST)).toThrow()
  })

  it('外部无法通过参数指定任意路径——签名里根本没有 path 参数', () => {
    // 这是类型层面的保证：openUserDb 只收 name + whitelist。
    // 这个测试确认调用契约——路径由 name 经白名单映射得出，不可注入。
    const db = openUserDb('张三', LIST); dbs.push(db)
    expect(db.path.endsWith('app.db')).toBe(true)
  })

  it('建好了 projects 表（schema 就位，CRUD 留给阶段3）', () => {
    const db = openUserDb('张三', LIST); dbs.push(db)
    const tbl = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()
    expect(tbl).toBeTruthy()
  })
})
