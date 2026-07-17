import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/auth/password.js'

describe('password', () => {
  it('哈希后能验证通过', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', h)).toBe(true)
  })

  it('错误密码验证失败', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  it('同一密码两次哈希结果不同——盐随机', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    // 但两者都能验证通过
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('哈希串里不含明文密码', async () => {
    const h = await hashPassword('secret123')
    expect(h).not.toContain('secret123')
  })

  it('格式损坏的哈希串验证失败而非抛错', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false)
  })
})
