import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUserDb } from '../../src/db/user-db.js'
import { resetStuckVoices } from '../../src/tts/recover.js'

/*
 * 线上真出过：一次部署重启正好压在配音中间，那条项目的 ttsState 永远停在
 * 'generating'，界面一直转圈，而根本没有任何进程在做这件事。
 * 用户等一整天也等不到，也不会想到去重试。
 */
const LIST = ['复位甲', '复位乙']
let dir: string
let prev: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recover-'))
  prev = process.env.SUREJACK_DATA_DIR
  process.env.SUREJACK_DATA_DIR = dir
})

afterEach(async () => {
  if (prev === undefined) delete process.env.SUREJACK_DATA_DIR
  else process.env.SUREJACK_DATA_DIR = prev
  await rm(dir, { recursive: true, force: true })
})

function seed (user: string, rows: Array<{ name: string; tts: string }>): string[] {
  const db = openUserDb(user, LIST)
  try {
    return rows.map((r) => {
      const p = db.createProject(r.name)
      db.updateProject(p.id, { ttsState: r.tts as never })
      return p.id
    })
  } finally {
    db.close()
  }
}

function stateOf (user: string, id: string): string {
  const db = openUserDb(user, LIST)
  try { return db.getProject(id)!.ttsState } finally { db.close() }
}

describe('开机复位卡住的配音', () => {
  it('generating 被复位成 error（界面上就是"未完成"，有重试入口）', () => {
    const [stuck] = seed('复位甲', [{ name: '半路被杀的', tts: 'generating' }])
    const r = resetStuckVoices(LIST)
    expect(r).toHaveLength(1)
    expect(r[0]?.name).toBe('半路被杀的')
    expect(stateOf('复位甲', stuck!)).toBe('error')
  })

  /*
   * ⚠️ 只动 generating 这一种。ready 是已经跑完的产物、none 是还没开始的草稿，
   * 碰它们等于凭空毁掉或重置用户的东西。
   */
  it.each([['ready'], ['none'], ['error']])('%s 状态一律不动', (st) => {
    const [id] = seed('复位甲', [{ name: '别碰我', tts: st }])
    resetStuckVoices(LIST)
    expect(stateOf('复位甲', id!)).toBe(st)
  })

  it('多个用户各自的库都要扫到', () => {
    seed('复位甲', [{ name: '甲的', tts: 'generating' }])
    seed('复位乙', [{ name: '乙的', tts: 'generating' }])
    expect(resetStuckVoices(LIST)).toHaveLength(2)
  })

  it('没有卡住的就什么都不做', () => {
    seed('复位甲', [{ name: '好好的', tts: 'ready' }])
    expect(resetStuckVoices(LIST)).toEqual([])
  })
})
