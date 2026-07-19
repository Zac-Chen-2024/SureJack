import Fastify, { type FastifyInstance, type FastifyError } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import multipart from '@fastify/multipart'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerSession } from './auth/session.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerProjectRoutes } from './projects/routes.js'
import { registerAssetRoutes } from './assets/routes.js'
import { registerTtsRoutes } from './tts/routes.js'
import { registerSubtitleRoutes } from './subtitles/routes.js'
import { registerLibraryRoutes } from './library/routes.js'
import { ExportQueue } from './queue/queue.js'
import { registerExportRoutes } from './queue/routes.js'
import { sweepFilms } from './compose/film.js'
import { openAuthDb } from './db/auth-db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 读取并校验单个白名单文件：必须存在、是合法 JSON、且是字符串数组。
 * 任何一条不满足都抛错——调用方决定"文件不存在"和"格式损坏"分别怎么处理。
 */
function readWhitelistFile (path: string): string[] {
  const raw = readFileSync(path, 'utf-8')   // 文件不存在会抛 ENOENT，交给调用方判断
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch (err) {
    throw new Error(`白名单文件 ${path} 不是合法 JSON：${(err as Error).message}`)
  }
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
    throw new Error(`白名单文件 ${path} 格式错误：必须是字符串数组`)
  }
  return list
}

/**
 * 加载白名单。真名单放 config/whitelist.json（不入库），
 * 只有"文件不存在"才回退到 example（仅供本地起服务，生产必须提供真名单）。
 *
 * ⚠️ "文件存在但格式损坏"绝不能静默降级到 example：生产环境如果真名单被
 * 误改坏，服务照常起来、健康检查照常 200，但两个真实用户全部收到 403，
 * 而示例白名单里的名字反而能登录——这是需要立刻被发现的安全事故，不是
 * "凑合换个候选文件"就能糊过去的场景。所以这里格式错误直接抛错。
 *
 * 接受 root 参数是为了让测试能指向一个临时目录，不用碰真实 config/。
 */
export function loadWhitelistFrom (root: string): string[] {
  const realPath = join(root, 'config', 'whitelist.json')
  try {
    return readWhitelistFile(realPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err   // 文件存在但解析/校验失败——不静默降级，把问题打到脸上
    }
  }
  const examplePath = join(root, 'config', 'whitelist.example.json')
  try {
    return readWhitelistFile(examplePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('找不到 config/whitelist.json 或 whitelist.example.json')
    }
    throw err
  }
}

export function loadWhitelist (): string[] {
  return loadWhitelistFrom(join(__dirname, '..'))
}

/**
 * 加载欢迎页文案（姓名 → 欢迎语）。
 * 真文案在 config/welcome.json（含真名，不入库），缺失时回退 example。
 * 与白名单同样的规则：文件存在但格式损坏 → 抛错，绝不静默降级。
 */
export function loadWelcome (): Record<string, string> {
  const root = join(__dirname, '..')
  for (const name of ['welcome.json', 'welcome.example.json']) {
    const p = join(root, 'config', name)
    if (!existsSync(p)) continue
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} 格式错误：应为 {姓名: 欢迎语} 对象`)
    }
    return parsed as Record<string, string>
  }
  return {}
}

/**
 * 全局错误处理器（设计文档第13节：不把内部错误细节泄漏给客户端）。
 * 任何未被路由自己 catch 的异常（DB I/O 错误、类型错误……）最终都会
 * 落到这里——完整记日志给服务端排障，但 5xx 只回一个通用消息，绝不把
 * error.message/stack/文件路径这类内部细节吐给客户端。4xx（比如 schema
 * 校验失败）可以回具体消息，那是帮用户改输入，不算泄漏。
 *
 * 单独导出是为了让测试能在一个不接真实 DB 的最小 Fastify 实例上直接验证
 * "非预期异常不泄漏细节"，不用去伪造真实的 SQLITE I/O 错误。
 */
export function attachErrorHandler (app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error)
    const status = error.statusCode ?? 500
    if (status >= 500) {
      /*
       * 5xx 一律不回真实原因——错误里常带文件路径、SQL、栈，泄露出去
       * 既帮不了用户又是攻击面。
       *
       * 但【只回一句"服务器内部错误"是不够的】：调背景排布那个 500 时，
       * 我为了看真实堆栈把服务重启加日志跑了两遍才定位到「配音时长是小数」。
       * 客户端手里没有任何能跟服务端日志对上的东西。
       *
       * 所以带上 reqId。它已经在每条日志里了（Fastify 自动加），
       * 用户报错时把这串给我，就能直接 grep 出那一条，不用复现。
       */
      reply.code(500).send({ error: '服务器内部错误', reqId: request.id })
    } else {
      reply.code(status).send({ error: error.message })
    }
  })
}

interface BuildOpts {
  logger?: boolean
  authDbPath?: string
  whitelist?: string[]
  cookieSecret?: string
  welcome?: Record<string, string>
  /**
   * 素材库所在的 data 根目录，默认为仓库的 data/。
   *
   * 【测试必须传一个临时目录】：真实 data/library/ 是 8.5GB 素材，
   * 扫一遍要跑几百次 ffprobe（其中不乏 1GB 的录屏），而且会往真实索引库
   * data/library/library.db 写数据。测试不该有那种副作用，也等不起。
   */
  libraryDataDir?: string
  /** 仅供测试注入假合成，生产不传——真调 Azure 会烧配额 */
  synthesizeLong?: Parameters<typeof registerTtsRoutes>[1]['synthesizeLong']
  /**
   * 启动后扫一遍，把"该有成片却没有"的项目补上队。
   *
   * 【默认关，只有生产入口打开】。测试里每建一个 server 都会触发的话，
   * 那就是几百次真 ffmpeg —— 而且会去动真实用户的 data/ 目录。
   * 这种东西必须显式 opt-in。
   */
  sweepFilmsOnStart?: boolean
}

export function buildServer (opts: BuildOpts = {}): FastifyInstance {
  // 部署拓扑（设计文档第 16 节）：nginx 单跳反代到 127.0.0.1。
  // 只信任这一跳，从 X-Forwarded-For 里解析出真实客户端 IP；
  // trustProxy: true 会信任整条链、取最左侧（客户端可任意伪造）的值，
  // 导致 @fastify/rate-limit 的按-IP 限流形同虚设，还会污染首登IP记录。
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: '127.0.0.1' })
  const whitelist = opts.whitelist ?? loadWhitelist()
  const welcome = opts.welcome ?? loadWelcome()
  const authDb = openAuthDb(opts.authDbPath ?? join(__dirname, '..', 'data', 'auth.db'))
  // 生产必须固定 COOKIE_SECRET（否则重启后所有会话失效）；
  // 没设时用随机值兜底，至少不会用空字符串/可预测值签名 cookie。
  const secret = opts.cookieSecret ?? process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex')
  const libraryDataDir = opts.libraryDataDir ?? join(__dirname, '..', 'data')
  const queue = new ExportQueue()

  attachErrorHandler(app)

  app.get('/api/health', async () => ({ status: 'ok' }))

  // 装配（register 是异步的，但 Fastify 会在 ready() 时按序完成）
  app.register(async (scope) => {
    await registerSession(scope, secret)
    // 限流只挂在 /api/login（真正需要防爆破的入口），不挂在整个 scope 上。
    // global:false 让插件默认不拦截任何路由；routes.ts 里 /api/login 自己
    // 用 config.rateLimit 显式 opt-in，复用这里注册的 max/timeWindow。
    // 之前挂在整个 scope 上时，whoami/logout 会跟 login 抢同一个"每分钟10次"
    // 的桶——前端每次页面加载都会问一次 whoami，正常使用就能把自己的登录
    // 顶到 429（已实测：8次whoami+2次login，第3次login直接429）。
    await scope.register(rateLimit, {
      global: false,
      max: 10, timeWindow: '1 minute',
      allowList: [],   // 生产可加内网白名单
    })
    registerAuthRoutes(scope, { authDb, whitelist, welcome })
    registerProjectRoutes(scope, { whitelist, libraryDataDir, queue })
    registerSubtitleRoutes(scope, { whitelist })
    registerLibraryRoutes(scope, { dataDir: libraryDataDir })

    // 背景视频可能很大；nginx 侧已放开到 500M
    await scope.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } })
    registerAssetRoutes(scope, { whitelist })
    registerTtsRoutes(scope, { whitelist, libraryDataDir, queue, synthesizeLong: opts.synthesizeLong })
    registerExportRoutes(scope, { whitelist, queue, libraryDataDir })
  })

  /*
   * 【补合扫描】挂在 onReady 上，而且【不 await】。
   *
   * 不 await 是故意的：扫描要为每个项目算一遍背景排布、读素材库，
   * 慢的时候要几秒。await 它就等于让健康检查和所有请求陪着一起等，
   * 而这件事晚几秒做完对谁都没影响。
   *
   * 排上的活本来就进 FIFO 队列串行跑，不会一口气开一堆 ffmpeg。
   */
  if (opts.sweepFilmsOnStart === true) {
    app.addHook('onReady', async () => {
      void sweepFilms({ whitelist, libraryDataDir, queue }, whitelist)
        .then((r) => {
          if (r.enqueued.length > 0) {
            app.log.info({ enqueued: r.enqueued, skipped: r.skipped }, '开机补合：已排上队')
          }
        })
        .catch((e) => app.log.warn({ err: e }, '开机补合扫描失败，不影响服务'))
    })
  }

  app.addHook('onClose', async () => authDb.close())

  // 托管前端构建产物（同域，cookie 自动生效、无 CORS）。
  // public/ 由 `cd web && npm run build` 生成；开发时用 vite dev + proxy，不走这里。
  const publicDir = join(__dirname, '..', 'public')
  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir })
    // SPA fallback：非 /api 的未知路径一律回 index.html，交给前端路由
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

// 直接运行时启动服务
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.COOKIE_SECRET) {
    console.error('⚠️  生产必须设 COOKIE_SECRET 环境变量（否则重启后所有会话失效）')
  }
  const app = buildServer({ logger: true, sweepFilmsOnStart: true })
  const port = Number(process.env.PORT ?? 8809)   // 避开 plus 的 8808
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`SureJack 后端监听 127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1) })
}
