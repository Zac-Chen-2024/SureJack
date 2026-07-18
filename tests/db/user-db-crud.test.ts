import { describe, it, expect, afterEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试CRUD甲', '测试CRUD乙']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function fresh (name = '测试CRUD甲'): UserDb {
  const db = openUserDb(name, LIST)
  // 每个用例从干净状态开始
  db.raw.exec('DELETE FROM projects')
  dbs.push(db)
  return db
}

describe('项目 CRUD', () => {
  it('新库没有项目', () => {
    expect(fresh().listProjects()).toEqual([])
  })

  it('创建项目返回完整对象，文案默认空、画幅默认 9:16', () => {
    const p = fresh().createProject('我的第一条')
    expect(p.name).toBe('我的第一条')
    expect(p.scriptText).toBe('')
    expect(p.aspectRatio).toBe('9:16')
    expect(p.id).toBeTruthy()
    expect(p.createdAt).toBeTruthy()
  })

  it('创建后能在列表里查到', () => {
    const db = fresh()
    db.createProject('甲')
    db.createProject('乙')
    expect(db.listProjects().map((p) => p.name).sort()).toEqual(['乙', '甲'])
  })

  it('按 id 取单个项目', () => {
    const db = fresh()
    const p = db.createProject('目标')
    expect(db.getProject(p.id)?.name).toBe('目标')
    expect(db.getProject('不存在的id')).toBeNull()
  })

  it('更新文案——文案是一等公民，必须能改', () => {
    const db = fresh()
    const p = db.createProject('稿子')
    const updated = db.updateProject(p.id, { scriptText: '老陈是在星期八醒来的。' })
    expect(updated?.scriptText).toBe('老陈是在星期八醒来的。')
    expect(db.getProject(p.id)?.scriptText).toBe('老陈是在星期八醒来的。')
  })

  it('部分更新不影响其他字段', () => {
    const db = fresh()
    const p = db.createProject('原名')
    db.updateProject(p.id, { scriptText: '正文' })
    const after = db.getProject(p.id)!
    expect(after.name).toBe('原名')          // 没传 name，不该被清空
    expect(after.aspectRatio).toBe('9:16')
  })

  it('更新会刷新 updatedAt', async () => {
    const db = fresh()
    const p = db.createProject('计时')
    await new Promise((r) => setTimeout(r, 1100))   // ISO 秒级精度，等 1 秒
    const updated = db.updateProject(p.id, { scriptText: 'x' })!
    expect(updated.updatedAt > p.updatedAt).toBe(true)
  })

  it('更新不存在的项目返回 null', () => {
    expect(fresh().updateProject('无此id', { scriptText: 'x' })).toBeNull()
  })

  it('删除项目', () => {
    const db = fresh()
    const p = db.createProject('待删')
    expect(db.deleteProject(p.id)).toBe(true)
    expect(db.getProject(p.id)).toBeNull()
    expect(db.deleteProject(p.id)).toBe(false)   // 删第二次返回 false
  })

  it('两个用户的项目互不可见——物理隔离', () => {
    const a = openUserDb('测试CRUD甲', LIST); dbs.push(a); a.raw.exec('DELETE FROM projects')
    const b = openUserDb('测试CRUD乙', LIST); dbs.push(b); b.raw.exec('DELETE FROM projects')
    a.createProject('甲的项目')
    expect(b.listProjects()).toEqual([])   // 乙看不到甲的
  })
})
