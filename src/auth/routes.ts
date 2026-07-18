import type { FastifyInstance } from 'fastify'
import type { AuthDb } from '../db/auth-db.js'
import { isWhitelisted } from './whitelist.js'
import { setSession, getSession, clearSession } from './session.js'

interface Deps { authDb: AuthDb; whitelist: string[]; welcome: Record<string, string> }

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

  app.post<{ Body: { name?: unknown; password?: unknown } }>('/api/login', {
    // 限流只挂在这条路由上：登录是唯一需要防爆破的入口（见 server.ts 的
    // rate-limit 注册，global:false，靠这里的 config.rateLimit 显式opt-in，
    // 用注册时的全局 max/timeWindow 兜底）。whoami/logout 不受影响。
    config: { rateLimit: {} },
  }, async (req, reply) => {
    // name/password 来自 JSON body，类型不受信任——JSON 允许数字/对象/数组。
    // 注意：这里没有用 Fastify schema 校验来挡类型，是因为 Fastify 默认的
    // ajv 校验器开着 coerceTypes（实测验证过），会把 12345 悄悄转成 "12345"
    // 让 schema 校验通过，起不到"非字符串就该拒绝"的效果。所以显式 typeof
    // 检查、直接回 400——不先转换类型就 .trim()/直接使用，非字符串输入会在
    // 老代码里抛 TypeError，被 Fastify 兜底成 500 并把错误原文（"xxx.trim
    // is not a function"）泄漏给客户端，违反设计文档第13节。未认证、零前置
    // 条件即可触发，必须在这里挡成干净的 400。
    const rawName = req.body?.name
    const rawPassword = req.body?.password
    if (rawName !== undefined && typeof rawName !== 'string') {
      return reply.code(400).send({ error: '姓名格式错误' })
    }
    if (rawPassword !== undefined && typeof rawPassword !== 'string') {
      return reply.code(400).send({ error: '密码格式错误' })
    }
    const name = (rawName ?? '').trim()
    const password = rawPassword ?? ''

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

  app.get('/api/whoami', async (req) => {
    const name = getSession(req)
    if (!name) return { name: null, welcome: null }
    return { name, welcome: deps.welcome[name] ?? '欢迎回来' }
  })
}
