import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'
import { DEFAULT_VOICE, LEGACY_VOICE, RATE_RANGE } from '../../src/tts/voices.js'

const LIST = ['测试配音参数甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function open (): UserDb {
  const db = openUserDb('测试配音参数甲', LIST)
  dbs.push(db)
  return db
}
function columns (db: UserDb): string[] {
  return (db.raw.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
}

describe('projects 配音参数列 —— 增量迁移', () => {
  it('新建的库带四列', () => {
    const cols = columns(open())
    for (const c of ['voice_name', 'voice_rate', 'voice_volume', 'voice_pitch']) {
      expect(cols).toContain(c)
    }
  })

  it('【新项目用晓辰】—— 文本配音的新默认', () => {
    const db = open()
    const p = db.createProject('新项目')
    expect(p.voiceName).toBe(DEFAULT_VOICE)
    expect(db.getProject(p.id)?.voiceName).toBe(DEFAULT_VOICE)
    expect(p.voiceRate).toBe(RATE_RANGE.default)
  })

  /*
   * 核心防线：线上已有 4 个真实项目，配音列只能靠 ALTER TABLE 补。
   * 【回填值必须是老默认晓晓】——那是老项目的事实（加这功能前都用晓晓）。
   * 回填成晓辰的话，它们的母带指纹会变，开机补合把它们全重烧一遍，
   * 而用户明确要求过往不动。这条测试把「回填=晓晓」钉死。
   */
  it('【旧库补列，老项目回填成晓晓，不是晓辰】—— 过往不重烧的根基', () => {
    const seed = open()
    const p = seed.createProject('迁移前就存在的项目')
    seed.updateProject(p.id, { scriptText: '老陈讲故事', bgmVolume: 0.42 })
    const path = seed.path
    seed.close()
    dbs = dbs.filter((d) => d !== seed)

    // 退回旧形态：摘掉四列，模拟加功能之前建的库
    const raw = new Database(path)
    for (const c of ['voice_name', 'voice_rate', 'voice_volume', 'voice_pitch']) {
      raw.exec(`ALTER TABLE projects DROP COLUMN ${c}`)
    }
    raw.close()

    const db = open()  // 重开触发迁移
    const reopened = db.getProject(p.id)
    expect(reopened?.voiceName).toBe(LEGACY_VOICE)   // ← 晓晓，不是晓辰
    expect(reopened?.voiceRate).toBe(0)
    expect(reopened?.scriptText).toBe('老陈讲故事')   // 数据不丢
    expect(reopened?.bgmVolume).toBe(0.42)
  })

  it('能改，不传的字段保持原值', () => {
    const db = open()
    const p = db.createProject('改参数')
    expect(db.updateProject(p.id, { voiceName: LEGACY_VOICE })?.voiceName).toBe(LEGACY_VOICE)
    expect(db.updateProject(p.id, { voiceRate: 30 })?.voiceRate).toBe(30)
    // 只改 rate，voiceName 保持
    expect(db.getProject(p.id)?.voiceName).toBe(LEGACY_VOICE)
  })
})
