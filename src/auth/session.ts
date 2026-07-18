import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const COOKIE_NAME = 'sj_session'

/**
 * 装配签名 cookie。secret 用于对 cookie 值做 HMAC 签名，
 * 篡改的 cookie 会被 unsign 判为无效——这是会话不可伪造的根基。
 */
export async function registerSession (app: FastifyInstance, secret: string): Promise<void> {
  await app.register(cookie, { secret })
}

/** 登录成功后写会话 cookie：httpOnly + secure + sameSite=lax（设计文档第3节） */
export function setSession (reply: FastifyReply, name: string): void {
  reply.setCookie(COOKIE_NAME, name, {
    signed: true,
    httpOnly: true,
    secure: true,        // 只在 HTTPS 下发送——生产是 HTTPS
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,   // 30 天
  })
}

/** 从请求里取出已验证的会话姓名；无 cookie 或签名无效返回 null */
export function getSession (request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE_NAME]
  if (!raw) return null
  const result = request.unsignCookie(raw)
  return result.valid ? result.value : null
}

/** 清除会话 */
export function clearSession (reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' })
}

/** Fastify preHandler 守卫：未登录返回 401 */
export async function requireAuth (request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (getSession(request) === null) {
    await reply.code(401).send({ error: '请先登录' })
  }
}
