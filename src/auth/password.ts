import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

const KEYLEN = 64
const SALTLEN = 16

/**
 * 用 scrypt 哈希密码。格式：<saltHex>:<hashHex>。
 * scrypt 是 node 内置的抗暴力破解 KDF，无需任何原生依赖。
 * 绝不明文、绝不用 MD5/SHA——那些不是为存密码设计的。
 */
export async function hashPassword (plain: string): Promise<string> {
  const salt = randomBytes(SALTLEN)
  const derived = (await scryptAsync(plain, salt, KEYLEN)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * 验证密码。用 timingSafeEqual 做定时安全比较，防止时序侧信道攻击。
 * 任何格式异常都返回 false，绝不抛错——避免把"哈希坏了"和"密码错了"暴露给攻击者。
 */
export async function verifyPassword (plain: string, stored: string): Promise<boolean> {
  try {
    const [saltHex, hashHex] = stored.split(':')
    if (!saltHex || !hashHex) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const derived = (await scryptAsync(plain, salt, KEYLEN)) as Buffer
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
