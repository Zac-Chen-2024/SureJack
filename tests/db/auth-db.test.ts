import { describe, it, expect, afterEach } from 'vitest'
import { openAuthDb, type AuthDb } from '../../src/db/auth-db.js'

let db: AuthDb
afterEach(() => db?.close())

describe('auth-db', () => {
  it('新用户没有密码', () => {
    db = openAuthDb(':memory:')
    expect(db.hasPassword('张三')).toBe(false)
  })

  it('设密码后 hasPassword 为真，且能验证', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw123', '1.2.3.4')
    expect(db.hasPassword('张三')).toBe(true)
    expect(await db.checkPassword('张三', 'pw123')).toBe(true)
    expect(await db.checkPassword('张三', 'wrong')).toBe(false)
  })

  it('首次设密码记录时间和 IP——抢注检测依据', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw', '9.9.9.9')
    const info = db.getFirstLoginInfo('张三')
    expect(info?.ip).toBe('9.9.9.9')
    expect(info?.createdAt).toBeTruthy()
  })

  it('重置密码不改写首登记录——首登 IP 是原始证据', async () => {
    db = openAuthDb(':memory:')
    await db.setPassword('张三', 'pw1', '1.1.1.1')
    const first = db.getFirstLoginInfo('张三')
    await db.setPassword('张三', 'pw2', '2.2.2.2')   // 重置
    expect(await db.checkPassword('张三', 'pw2')).toBe(true)
    expect(db.getFirstLoginInfo('张三')?.ip).toBe('1.1.1.1')  // 首登 IP 不变
  })

  it('未设密码的用户 checkPassword 为 false，不抛错', async () => {
    db = openAuthDb(':memory:')
    expect(await db.checkPassword('查无此人', 'x')).toBe(false)
  })
})
