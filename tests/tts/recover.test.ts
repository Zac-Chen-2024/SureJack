import { describe, it, expect, afterEach } from 'vitest'
import { rm } from 'node:fs/promises'
import { openUserDb } from '../../src/db/user-db.js'
import { userDbDir } from '../../src/auth/whitelist.js'
import { resetStuckVoices } from '../../src/tts/recover.js'

/*
 * 线上真出过：一次部署重启正好压在配音中间，那条项目的 ttsState 永远停在
 * 'generating'，界面一直转圈，而根本没有任何进程在做这件事。
 * 用户等一整天也等不到，也不会想到去重试。
 */
/*
 * ⚠️【data 根目录是模块加载时按 __dirname 算死的，换不了】。
 * 原来这里用 SUREJACK_DATA_DIR 指到临时目录——那个环境变量根本不存在，
 * 于是测试在【真实的 data 目录】里建了用户，跑完还留在那儿。
 * 现在用不会和真人撞名的用户名，跑完删干净。
 */
const LIST = ['__测试复位甲__', '__测试复位乙__']

afterEach(async () => {
  for (const u of LIST) await rm(userDbDir(u, LIST), { recursive: true, force: true })
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
    const [stuck] = seed(LIST[0]!, [{ name: '半路被杀的', tts: 'generating' }])
    const r = resetStuckVoices(LIST)
    expect(r).toHaveLength(1)
    expect(r[0]?.name).toBe('半路被杀的')
    expect(stateOf(LIST[0]!, stuck!)).toBe('error')
  })

  /*
   * ⚠️ 只动 generating 这一种。ready 是已经跑完的产物、none 是还没开始的草稿，
   * 碰它们等于凭空毁掉或重置用户的东西。
   */
  it.each([['ready'], ['none'], ['error']])('%s 状态一律不动', (st) => {
    const [id] = seed(LIST[0]!, [{ name: '别碰我', tts: st }])
    resetStuckVoices(LIST)
    expect(stateOf(LIST[0]!, id!)).toBe(st)
  })

  it('多个用户各自的库都要扫到', () => {
    seed(LIST[0]!, [{ name: '甲的', tts: 'generating' }])
    seed(LIST[1]!, [{ name: '乙的', tts: 'generating' }])
    expect(resetStuckVoices(LIST)).toHaveLength(2)
  })

  it('没有卡住的就什么都不做', () => {
    seed(LIST[0]!, [{ name: '好好的', tts: 'ready' }])
    expect(resetStuckVoices(LIST)).toEqual([])
  })
})
