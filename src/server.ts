import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerSession } from './auth/session.js'
import { registerAuthRoutes } from './auth/routes.js'
import { openAuthDb } from './db/auth-db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 加载白名单。真名单放 config/whitelist.json（不入库），
 * 缺失时回退到 example（仅供本地起服务，生产必须提供真名单）。
 */
export function loadWhitelist (): string[] {
  const root = join(__dirname, '..')
  for (const name of ['whitelist.json', 'whitelist.example.json']) {
    try {
      const raw = readFileSync(join(root, 'config', name), 'utf-8')
      const list = JSON.parse(raw)
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) return list
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 config/whitelist.json 或 whitelist.example.json')
}

interface BuildOpts {
  logger?: boolean
  authDbPath?: string
  whitelist?: string[]
  cookieSecret?: string
}

export function buildServer (opts: BuildOpts = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true })
  const whitelist = opts.whitelist ?? loadWhitelist()
  const authDb = openAuthDb(opts.authDbPath ?? join(__dirname, '..', 'data', 'auth.db'))
  // 生产必须固定 COOKIE_SECRET（否则重启后所有会话失效）；
  // 没设时用随机值兜底，至少不会用空字符串/可预测值签名 cookie。
  const secret = opts.cookieSecret ?? process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex')

  app.get('/api/health', async () => ({ status: 'ok' }))

  // 装配（register 是异步的，但 Fastify 会在 ready() 时按序完成）
  app.register(async (scope) => {
    await registerSession(scope, secret)
    // 登录限流：每 IP 每分钟最多 10 次尝试。密码是唯一的门，必须挡爆破。
    await scope.register(rateLimit, {
      max: 10, timeWindow: '1 minute',
      allowList: [],   // 生产可加内网白名单
    })
    registerAuthRoutes(scope, { authDb, whitelist })
  })

  app.addHook('onClose', async () => authDb.close())
  return app
}

// 直接运行时启动服务
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.COOKIE_SECRET) {
    console.error('⚠️  生产必须设 COOKIE_SECRET 环境变量（否则重启后所有会话失效）')
  }
  const app = buildServer({ logger: true })
  const port = Number(process.env.PORT ?? 8809)   // 避开 plus 的 8808
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`SureJack 后端监听 127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1) })
}
