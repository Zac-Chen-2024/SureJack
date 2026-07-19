import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试迁移甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function open (): UserDb {
  const db = openUserDb('测试迁移甲', LIST)
  dbs.push(db)
  return db
}

function columns (db: UserDb): string[] {
  return (db.raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
}

describe('projects.bgm_library_id —— 增量迁移', () => {
  it('新建的库带 bgm_library_id 列', () => {
    const db = open()
    expect(columns(db)).toContain('bgm_library_id')
  })

  it('新项目的 bgmLibraryId 默认为 null', () => {
    const db = open()
    const p = db.createProject('默认值')
    expect(p.bgmLibraryId).toBe(null)
    expect(db.getProject(p.id)?.bgmLibraryId).toBe(null)
  })

  /**
   * 这条是本任务的核心防线。
   *
   * CREATE TABLE IF NOT EXISTS 对【已存在的表】完全不生效——线上库里
   * projects 表早就建好了，光改 CREATE 语句加一列，真实用户的库永远也不会
   * 有这一列，一读就 "no such column"。本项目为这个陷阱踩过一次坑。
   *
   * 用 DROP COLUMN 把库退回到「加列之前」的形态，再重新打开，
   * 验证迁移真的补上了列**且原有数据一行不丢**。
   */
  it('已存在的旧库会被 ALTER TABLE 补上列，且原有数据不丢', () => {
    const seed = open()
    const p = seed.createProject('迁移前就存在的项目')
    seed.updateProject(p.id, { scriptText: '老陈今天讲个故事', bgmVolume: 0.42 })
    const path = seed.path
    seed.close()
    dbs = dbs.filter((d) => d !== seed)

    // 退回旧形态：把新列摘掉，模拟一个加列之前建的库
    const raw = new Database(path)
    raw.exec('ALTER TABLE projects DROP COLUMN bgm_library_id')
    const before = (raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
    expect(before).not.toContain('bgm_library_id')
    raw.close()

    const db = open()
    expect(columns(db)).toContain('bgm_library_id')
    const reopened = db.getProject(p.id)
    expect(reopened?.scriptText).toBe('老陈今天讲个故事')
    expect(reopened?.bgmVolume).toBe(0.42)
    expect(reopened?.bgmLibraryId).toBe(null)
  })

  it('能存下素材库 BGM 的 id，并能改回 null', () => {
    const db = open()
    const p = db.createProject('选了 BGM')
    const set = db.updateProject(p.id, { bgmLibraryId: 'bgm-item-123' })
    expect(set?.bgmLibraryId).toBe('bgm-item-123')
    expect(db.getProject(p.id)?.bgmLibraryId).toBe('bgm-item-123')

    // 不传该字段时保持原值——部分更新的语义
    const untouched = db.updateProject(p.id, { name: '改个名' })
    expect(untouched?.bgmLibraryId).toBe('bgm-item-123')

    // 显式传 null = 清空选择
    const cleared = db.updateProject(p.id, { bgmLibraryId: null })
    expect(cleared?.bgmLibraryId).toBe(null)
    expect(db.getProject(p.id)?.bgmLibraryId).toBe(null)
  })
})

/*
 * 改默认音量【绝不能动已有项目】。
 *
 * 默认从 10% 调到 15% 时，如果实现方式是"迁移里 UPDATE 一遍"，
 * 用户手工调过的值会被静默改回去——那是不可逆的偏好丢失。
 * ALTER TABLE 的 DEFAULT 只作用于新插入的行，这条测试钉住这个语义。
 */
describe('默认音量变更不影响已有项目', () => {
  it('已存的 bgm_volume 不被迁移覆盖', () => {
    const db = open()
    const p = db.createProject('老项目')
    // 模拟用户手工调过音量
    db.raw.prepare('UPDATE projects SET bgm_volume = 0.42 WHERE id = ?').run(p.id)

    // 重新打开：会再跑一遍建表和 addCol 迁移
    const again = open()
    expect(again.getProject(p.id)?.bgmVolume).toBe(0.42)
  })

  it('新建的项目用新默认值 15%', () => {
    const db = open()
    expect(db.createProject('新项目').bgmVolume).toBe(0.15)
  })
})
