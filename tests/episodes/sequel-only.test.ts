import { describe, it, expect, afterEach } from 'vitest'
import { rm } from 'node:fs/promises'
import { openUserDb } from '../../src/db/user-db.js'
import { userDbDir } from '../../src/auth/whitelist.js'
import { splitStory, sequelTitles } from '../../src/episodes/split.js'

/*
 * 「只做续集」：用户有时候只想发那一集。
 *
 * 断点和引子照样要划一次——不划就不知道续集从哪儿开始、引子是哪几句。
 * 变的只是产出：主片不配音、不烧录，省一半 Azure 配额和一半烧录时间。
 *
 * ⚠️ 做法是把【这条项目本身】变成续集，不是"建续集 + 删主片"：
 *   · 不留空壳：一条永远不会配音的主片只会在列表里碍眼；
 *   · 也不删：删是不可逆的，而用户手里的原文只在剪贴板里。
 */
const USER = '__测试只做续集__'
const LIST = [USER]
afterEach(async () => { await rm(userDbDir(USER, LIST), { recursive: true, force: true }) })

const TEXT = Array.from({ length: 40 }, (_, i) => `这是第${i}句话，讲了一点点内容。`).join('')

describe('只做续集：产出一条，不是两条', () => {
  it('项目本身变成续集，且【不新建任何项目】', () => {
    const db = openUserDb(USER, LIST)
    const p = db.createProject('周周撸铁')
    db.updateProject(p.id, { scriptText: TEXT })
    const before = db.listProjects().length

    const split = splitStory({
      text: TEXT, breakIndex: 20, introEndIndex: 3,
      mainInVideoTitle: '周周撸铁',
    })
    const t = sequelTitles({ name: '周周撸铁', inVideoTitle: '周周撸铁' })
    db.updateProject(p.id, {
      name: t.name, scriptText: split.sequelText,
      coverTitle: t.coverTitle, inVideoTitle: t.inVideoTitle, episodeIndex: 2,
    })

    const after = db.listProjects()
    expect(after).toHaveLength(before)          // ← 一条都没多
    const only = after[0]!
    expect(only.id).toBe(p.id)                  // 还是原来那条
    expect(only.name).toBe('周周撸铁2')          // 名字默认带 2
    expect(only.coverTitle).toBe('周周撸铁2')
    expect(only.inVideoTitle).toBe('周周撸铁')   // 片内标题不带 2：两集同一个故事
    /*
     * ⚠️ parentProjectId 必须是 null。指向一条不存在的主片会让列表
     * 按"续集"分组、去找那个不存在的父项目——它现在是一条独立的片子。
     */
    expect(only.parentProjectId).toBeNull()
    expect(only.episodeIndex).toBe(2)           // 观众看到的确实是第二集
    db.close()
  })

  it('【提醒语还在】：观众看到的仍然是"第二集"', () => {
    const split = splitStory({
      text: TEXT, breakIndex: 20, introEndIndex: 3,
      mainInVideoTitle: '周周撸铁',
    })
    expect(split.sequelText).toContain('周周撸铁')
    expect(split.sequelText).toContain('第二集')
  })

  it('续集文案 = 引子 + 提醒语 + 断点之后的正文，不含主片正文', () => {
    const split = splitStory({
      text: TEXT, breakIndex: 20, introEndIndex: 3,
      mainInVideoTitle: '标题',
    })
    // 断点之后的第一句一定在
    expect(split.sequelText).toContain('这是第21句话')
    // 主片中段（既不在引子里、也不在续集正文里）一定不在
    expect(split.sequelText).not.toContain('这是第15句话')
  })
})
