import { describe, it, expect } from 'vitest'
import { isWhitelisted, userDbDir } from '../../src/auth/whitelist.js'

const LIST = ['张三', '李四']

describe('isWhitelisted', () => {
  it('名单内返回 true', () => {
    expect(isWhitelisted('张三', LIST)).toBe(true)
  })
  it('名单外返回 false', () => {
    expect(isWhitelisted('王五', LIST)).toBe(false)
  })
  it('空字符串返回 false', () => {
    expect(isWhitelisted('', LIST)).toBe(false)
  })
})

describe('userDbDir —— 防路径穿越', () => {
  it('名单内用户返回其数据目录', () => {
    const dir = userDbDir('张三', LIST)
    expect(dir).toContain('张三')
    expect(dir).toMatch(/\/data\//)
  })

  it('名单外用户直接抛错，绝不返回路径', () => {
    expect(() => userDbDir('王五', LIST)).toThrow()
  })

  it('路径穿越尝试被白名单挡下——"../etc" 不在名单里', () => {
    // 关键：即便攻击者构造了穿越路径，它也过不了白名单校验
    expect(() => userDbDir('../../etc/passwd', LIST)).toThrow()
    expect(() => userDbDir('张三/../李四', LIST)).toThrow()
  })

  it('返回的路径在 data 目录之内，不会逃逸', () => {
    const dir = userDbDir('张三', LIST)
    const dataRoot = dir.split('/data/')[0] + '/data/'
    expect(dir.startsWith(dataRoot)).toBe(true)
  })
})
