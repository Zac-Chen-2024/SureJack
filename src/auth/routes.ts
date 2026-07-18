import type { FastifyInstance } from 'fastify'
import type { AuthDb } from '../db/auth-db.js'
import { isWhitelisted } from './whitelist.js'
import { setSession, getSession, clearSession } from './session.js'

interface Deps { authDb: AuthDb; whitelist: string[] }

/**
 * 挂载登录/登出/whoami。
 *
 * 登录流程（设计文档第 3 节）：
 *   - 名单外 → 403 拒绝
 *   - 名单内 + 未设密码 → 设密码并登入（首登，记 IP）
 *   - 名单内 + 已设密码 → 验证，对则登入，错则 401
 */
export function registerAuthRoutes (app: FastifyInstance, deps: Deps): void {
  const { authDb, whitelist } = deps

  app.post<{ Body: { name?: string; password?: string } }>('/api/login', async (req, reply) => {
    const name = req.body?.name?.trim() ?? ''
    const password = req.body?.password ?? ''

    if (!isWhitelisted(name, whitelist)) {
      return reply.code(403).send({ error: '你谁啊' })
    }
    if (!password) {
      return reply.code(400).send({ error: '请输入密码' })
    }

    const ip = req.ip
    if (!authDb.hasPassword(name)) {
      // 首次设密码才校验最小长度（与 reset CLI 标准一致，见 cli/reset-password.ts）。
      // 已设密码的验证阶段不校验长度——那会把已有短密码的人锁死。
      if (password.length < 4) {
        return reply.code(400).send({ error: '密码至少4位' })
      }
      // 首次登录：设密码（记 IP 供抢注检测）。
      // 并发下两个"首次登录"请求都会看到这里的 hasPassword()===false
      // （已实测验证：hashPassword 是 await 点，会把两个请求都放行到这里）。
      // authDb.setPassword 内部自己会在 hash 算完后重新查一次是否已存在，
      // 存在就 UPDATE、不存在才 INSERT，而 better-sqlite3 是同步阻塞的，
      // 单进程单连接下那段"查完就写"之间不会被其他回调打断——所以实测
      // 这里不会真的撞 SQLITE_CONSTRAINT（会是"后写覆盖先写"，而不是抛异常）。
      // 即便如此，try/catch 仍留着当兜底：万一 authDb 实现将来改成盲 INSERT，
      // 或部署改成多进程共享同一个 auth.db 文件，唯一约束真的会抛出来，
      // 这里不能让未捕获异常把请求打成裸 500——按"已存在密码"重新验证一次，
      // 谁先写完，后来者就必须用刚设的密码重新验证（而不是被当成免密登入）。
      try {
        await authDb.setPassword(name, password, ip)
        setSession(reply, name)
        return { name, firstLogin: true }
      } catch (err) {
        if (!authDb.hasPassword(name)) {
          // 不是抢注竞态导致的失败，是别的错误——不要吞掉，交给 Fastify 兜底 500
          throw err
        }
        // 抢注竞态：对方赢了，按已有密码验证这次提交的密码
        if (await authDb.checkPassword(name, password)) {
          setSession(reply, name)
          return { name, firstLogin: false }
        }
        return reply.code(401).send({ error: '密码错误' })
      }
    }

    if (await authDb.checkPassword(name, password)) {
      setSession(reply, name)
      return { name, firstLogin: false }
    }
    return reply.code(401).send({ error: '密码错误' })
  })

  app.post('/api/logout', async (_req, reply) => {
    clearSession(reply)
    return { ok: true }
  })

  app.get('/api/whoami', async (req) => ({ name: getSession(req) }))
}
