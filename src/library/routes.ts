import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/session.js'
import { openLibraryDb, type LibraryDb } from './library-db.js'
import { BUCKETS, isBucket } from './paths.js'
import { listBucket, scanBucket } from './scan.js'

export interface LibraryDeps {
  /** 素材库所在的 data 根目录。库在 <dataDir>/library/，全站一份，不属于任何用户 */
  dataDir: string
}

/**
 * 素材库只读接口。
 *
 * 与项目接口的关键差别：**素材库是全局公用的**，不经过 userDbDir()，
 * 所以这里没有"按用户过滤"这回事——甲乙两个人看到的是同一份 210 个文件。
 * 登录只是"进门要刷卡"，不是"每人一个库"。
 *
 * ⚠️ 桶名是纯外部输入（来自 /api/library/:bucket 路由参数），而素材库
 * 没有 userDbDir() 那道兜底校验，**isBucket 是唯一一道防路径穿越的闸**。
 * 所以每个 handler 在拼任何路径之前都必须先过 isBucket——
 * 不清洗、不修正，只回答"它是不是那四个字符串之一"。
 */
export function registerLibraryRoutes (app: FastifyInstance, deps: LibraryDeps): void {
  const { dataDir } = deps

  /** 开库、跑一段、必定关库（和项目接口同一套路：SQLite 打开是微秒级） */
  function withLibraryDb<T> (fn: (db: LibraryDb) => T): T {
    const db = openLibraryDb(dataDir)
    try { return fn(db) } finally { db.close() }
  }

  app.get<{ Params: { bucket: string } }>(
    '/api/library/:bucket', { preHandler: requireAuth }, async (req, reply) => {
      const { bucket } = req.params
      // 【先查白名单再碰路径】——唯一一道闸
      if (!isBucket(bucket)) return reply.code(400).send({ error: `未知的素材桶：${bucket}` })
      // 还没扫过的桶返回空数组，不是 404：桶是存在的，只是索引还空着
      return { items: withLibraryDb((db) => listBucket(db, bucket)) }
    })

  /**
   * 全量重扫四个桶。
   *
   * 幂等：scanBucket 靠 UNIQUE (bucket, filename) 去重，已入库的文件
   * 连 ffprobe 都不会重跑（地铁跑酷桶是 GB 级文件，重探一遍是纯浪费）。
   *
   * 返回每个桶【当前索引里的总条数】而不是本次新增数——重复扫描时
   * 新增数恒为 0，那个数字对前端毫无意义；用户想知道的是"库里现在有多少"。
   */
  app.post('/api/library/scan', { preHandler: requireAuth }, async () => {
    const db = openLibraryDb(dataDir)
    try {
      const scanned: Record<string, number> = {}
      // 顺序扫描：ffprobe 是子进程，四个桶并发起进程对 IO 没好处
      for (const bucket of BUCKETS) {
        const r = await scanBucket(db, dataDir, bucket)
        scanned[bucket] = r.total
      }
      return { scanned }
    } finally {
      db.close()
    }
  })
}
