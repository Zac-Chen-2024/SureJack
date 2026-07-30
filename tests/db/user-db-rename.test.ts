import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试改名甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function open (): UserDb {
  const db = openUserDb('测试改名甲', LIST)
  dbs.push(db)
  return db
}
function columns (db: UserDb): string[] {
  return (db.raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
}

describe('projects 改名列 —— 增量迁移', () => {
  it('新建的库带四列', () => {
    const cols = columns(open())
    for (const c of ['rename_enabled', 'rename_state', 'rename_analysis_json', 'rename_map_json']) {
      expect(cols).toContain(c)
    }
  })

  it('【新项目默认开改名、state=none】', () => {
    const db = open()
    const p = db.createProject('新项目')
    expect(p.renameEnabled).toBe(true)
    expect(p.renameState).toBe('none')
    expect(p.renameAnalysisJson).toBeNull()
    const reopened = db.getProject(p.id)
    expect(reopened?.renameEnabled).toBe(true)
  })

  /*
   * 核心防线：老项目一律【不进改名链、不被阻拦】——迁移回填必须是
   * enabled=false / none，否则老文本项目会突然被"未确认改名"挡住配音。
   */
  it('【旧库补列，老项目回填成 关+none】—— 不打扰过往', () => {
    const seed = open()
    const p = seed.createProject('迁移前就存在的项目')
    seed.updateProject(p.id, { scriptText: '老陈讲故事' })
    const path = seed.path
    seed.close()
    dbs = dbs.filter((d) => d !== seed)

    const raw = new Database(path)
    for (const c of ['rename_enabled', 'rename_state', 'rename_analysis_json', 'rename_map_json']) {
      raw.exec(`ALTER TABLE projects DROP COLUMN ${c}`)
    }
    raw.close()

    const db = open()  // 重开触发迁移
    const reopened = db.getProject(p.id)
    expect(reopened?.renameEnabled).toBe(false)   // ← 关，老项目不进链
    expect(reopened?.renameState).toBe('none')
    expect(reopened?.scriptText).toBe('老陈讲故事')  // 数据不丢
  })

  it('能改 state / 映射 / 开关，不传的保持原值；null 能清空', () => {
    const db = open()
    const p = db.createProject('改改名')
    expect(db.updateProject(p.id, { renameState: 'proposed', renameAnalysisJson: '{"x":1}' })?.renameState).toBe('proposed')
    // 只改 map，state 保持 proposed
    expect(db.updateProject(p.id, { renameMapJson: '{"y":2}' })?.renameState).toBe('proposed')
    expect(db.getProject(p.id)?.renameMapJson).toBe('{"y":2}')
    // 关掉 + 清空分析
    const off = db.updateProject(p.id, { renameEnabled: false, renameAnalysisJson: null })
    expect(off?.renameEnabled).toBe(false)
    expect(off?.renameAnalysisJson).toBeNull()
  })
})
