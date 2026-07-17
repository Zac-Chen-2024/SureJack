import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

export function buildServer (opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false })

  app.get('/api/health', async () => ({ status: 'ok' }))

  return app
}

// 直接运行时启动服务
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer({ logger: true })
  const port = Number(process.env.PORT ?? 8809)   // 避开 plus 的 8808
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`SureJack 后端监听 127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1) })
}
