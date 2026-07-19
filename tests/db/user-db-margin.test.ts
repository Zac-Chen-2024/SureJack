import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'
import { DEFAULT_SUBTITLE_MARGIN_V } from '../../src/subtitles/ass.js'

const LIST = ['测试字幕高度甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function open (): UserDb {
  const db = openUserDb('测试字幕高度甲', LIST)
  dbs.push(db)
  return db
}

function columns (db: UserDb): string[] {
  return (db.raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
}

describe('projects.subtitle_margin_v —— 增量迁移', () => {
  it('新建的库带 subtitle_margin_v 列', () => {
    const db = open()
    expect(columns(db)).toContain('subtitle_margin_v')
  })

  it('新项目的默认值就是样式行里原来写死的那个数——新老项目观感一致', () => {
    const db = open()
    const p = db.createProject('默认高度')
    expect(p.subtitleMarginV).toBe(DEFAULT_SUBTITLE_MARGIN_V)
    expect(db.getProject(p.id)?.subtitleMarginV).toBe(DEFAULT_SUBTITLE_MARGIN_V)
  })

  /**
   * 本任务的核心防线，和 bgm_library_id 那条同一个道理：
   * CREATE TABLE IF NOT EXISTS 对【已存在的表】一行都不改。线上库里
   * 陈梓昂名下已经有 4 个真实项目，这一列只能靠 ALTER TABLE 补上。
   *
   * 更要紧的是【补上时的取值】：ALTER TABLE ... NOT NULL DEFAULT 会把
   * 默认值回填进所有既有行。这个默认值必须等于原来写死在样式行里的数，
   * 否则用户什么都没动，四个老项目的字幕位置会集体挪一下。
   */
  it('已存在的旧库会被 ALTER TABLE 补上列，老项目回填成默认值且数据不丢', () => {
    const seed = open()
    const p = seed.createProject('迁移前就存在的项目')
    seed.updateProject(p.id, { scriptText: '老陈今天讲个故事', bgmVolume: 0.42 })
    const path = seed.path
    seed.close()
    dbs = dbs.filter((d) => d !== seed)

    // 退回旧形态：把新列摘掉，模拟一个加列之前建的库
    const raw = new Database(path)
    raw.exec('ALTER TABLE projects DROP COLUMN subtitle_margin_v')
    const before = (raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
    expect(before).not.toContain('subtitle_margin_v')
    raw.close()

    const db = open()
    expect(columns(db)).toContain('subtitle_margin_v')
    const reopened = db.getProject(p.id)
    expect(reopened?.subtitleMarginV).toBe(DEFAULT_SUBTITLE_MARGIN_V)
    expect(reopened?.scriptText).toBe('老陈今天讲个故事')
    expect(reopened?.bgmVolume).toBe(0.42)
  })

  it('能改，也能改成 0（"贴着底边"是有意义的值，不是"没设置过"）', () => {
    const db = open()
    const p = db.createProject('改高度')
    expect(db.updateProject(p.id, { subtitleMarginV: 640 })?.subtitleMarginV).toBe(640)
    expect(db.updateProject(p.id, { subtitleMarginV: 0 })?.subtitleMarginV).toBe(0)
  })

  it('不传该字段时保持原值', () => {
    const db = open()
    const p = db.createProject('保持原值')
    db.updateProject(p.id, { subtitleMarginV: 500 })
    expect(db.updateProject(p.id, { name: '换个名字' })?.subtitleMarginV).toBe(500)
  })
})
