import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import { whoseBirthday } from '../../src/auth/birthday.js'

/**
 * 「忘了密码」。
 *
 * ⚠️ 这个功能的安全性【全部】压在限流上：月+日只有 366 种可能，
 * 有效答案就名单里那两个人。所以这里最要紧的断言不是"答对能改密码"，
 * 而是那几条【防止它变成后门】的性质：答错不泄漏信息、不在名单里的人
 * 改不了、改完不自动登入。
 */

const LIST = ['测试找回甲', '测试找回乙']
const BIRTHDAYS = {
  测试找回甲: { month: 3, day: 15 },
  测试找回乙: { month: 8, day: 22 },
}

let app: FastifyInstance
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgot-'))
  app = buildServer({
    authDbPath: join(dir, 'auth.db'),
    whitelist: LIST,
    welcome: {},
    birthdays: BIRTHDAYS,
    cookieSecret: 'test-cookie-secret-long-enough-for-signing',
    libraryDataDir: dir,
  })
  await app.ready()
})

afterEach(async () => {
  await app?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

const forgot = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/forgot-password', payload: payload as object })
const login = (name: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { name, password } })

describe('生日匹配（纯函数）', () => {
  it('对上了就说是谁', () => {
    expect(whoseBirthday(BIRTHDAYS, LIST, 3, 15)).toBe('测试找回甲')
    expect(whoseBirthday(BIRTHDAYS, LIST, 8, 22)).toBe('测试找回乙')
  })

  it('没人是这天生日 → null', () => {
    expect(whoseBirthday(BIRTHDAYS, LIST, 12, 1)).toBe(null)
  })

  /*
   * 配置文件里万一混进一个不在白名单的名字，也不该能靠它重置出一个账号。
   * 白名单是唯一的身份来源，别的地方都不能绕过它。
   */
  it('【生日表里有但白名单里没有 → 不认】否则配置文件成了第二个白名单', () => {
    const table = { ...BIRTHDAYS, 查无此人: { month: 1, day: 1 } }
    expect(whoseBirthday(table, LIST, 1, 1)).toBe(null)
  })

  it('月日越界一律不认，不做夹逼', () => {
    expect(whoseBirthday(BIRTHDAYS, LIST, 13, 15)).toBe(null)
    expect(whoseBirthday(BIRTHDAYS, LIST, 3, 0)).toBe(null)
    expect(whoseBirthday(BIRTHDAYS, LIST, NaN, 15)).toBe(null)
    expect(whoseBirthday(BIRTHDAYS, LIST, 3.5, 15)).toBe(null)
  })
})

describe('忘了密码', () => {
  it('答对了就能改掉密码，并且新密码真的能登进去', async () => {
    // 先用旧密码建账号
    expect((await login('测试找回甲', '老密码1234')).statusCode).toBe(200)

    const res = await forgot({ month: 3, day: 15, newPassword: '新密码abc' })
    expect(res.statusCode).toBe(200)

    expect((await login('测试找回甲', '老密码1234')).statusCode).toBe(401)
    expect((await login('测试找回甲', '新密码abc')).statusCode).toBe(200)
  })

  /*
   * 说"这个生日不对"就等于给了一个"某天是不是某人生日"的查询接口，
   * 一天天问下去能把真实生日问出来。所以对错只有同一句话。
   */
  it('【答错不解释】提示里不能出现任何姓名或日期线索', async () => {
    const res = await forgot({ month: 12, day: 1, newPassword: '随便啊啊啊' })
    expect(res.statusCode).toBe(403)
    const body = res.body
    expect(JSON.parse(body).error).toBe('想混进来？')
    for (const name of LIST) expect(body).not.toContain(name)
    expect(body).not.toContain('生日')
  })

  it('答错了绝不能动任何人的密码', async () => {
    expect((await login('测试找回甲', '原始密码')).statusCode).toBe(200)
    await forgot({ month: 12, day: 1, newPassword: '入侵者的密码' })
    expect((await login('测试找回甲', '原始密码')).statusCode).toBe(200)
    expect((await login('测试找回甲', '入侵者的密码')).statusCode).toBe(401)
  })

  /*
   * 猜中生日的人不该顺带拿到会话——让他自己去登录页用新密码登一次。
   * 省这一步收益很小，代价是猜中即入侵成功。
   */
  it('【改完不自动登入】响应里不能带会话 cookie', async () => {
    const res = await forgot({ month: 3, day: 15, newPassword: '新密码abc' })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie']
    expect(setCookie).toBeUndefined()
  })

  it('密码太短要挡住，别让人把账号改成 4 位以下', async () => {
    const res = await forgot({ month: 3, day: 15, newPassword: 'ab' })
    expect(res.statusCode).toBe(400)
  })

  it('非字符串密码回干净的 400，不是 500', async () => {
    for (const bad of [12345, null, { a: 1 }, ['x']]) {
      const res = await forgot({ month: 3, day: 15, newPassword: bad })
      expect(res.statusCode).toBe(400)
    }
  })

  it('月日是字符串也认（表单里出来的都是字符串）', async () => {
    const res = await forgot({ month: '3', day: '15', newPassword: '新密码abc' })
    expect(res.statusCode).toBe(200)
  })

  /*
   * 这条守的是「限流真的挂上了」。具体的 max 会变，但"第 N 次之后开始 429"
   * 这件事必须成立——它是这个功能唯一的防线，被谁不小心摘掉就等于
   * 把两个账号的密码公开。
   */
  it('【必须限流】连续猜会被 429 挡住，这是这个功能唯一的防线', async () => {
    const codes: number[] = []
    for (let i = 0; i < 8; i += 1) {
      codes.push((await forgot({ month: 12, day: 1, newPassword: '猜猜看' })).statusCode)
    }
    expect(codes).toContain(429)
    // 而且要在很少的次数内就开始挡——366 种可能，放行太多就没意义了
    expect(codes.indexOf(429)).toBeLessThanOrEqual(6)
  })
})
