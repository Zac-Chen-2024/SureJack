import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/session.js'
import { openLibraryDb, type LibraryDb } from './library-db.js'
import { BUCKETS, isBucket } from './paths.js'
import { listBucket, scanBucket, getLibraryItem } from './scan.js'
import { libraryItemPath } from './paths.js'
import { playbackMimeFor, parseRange } from '../assets/storage.js'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

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

  /**
   * 取素材文件本身，供预览播放。
   *
   * 【为什么需要它】：预览要让背景音乐跟着一起响，而 BGM 来自素材库。
   * 原来只有列表接口，前端拿得到文件名却拿不到内容。
   *
   * 【按 id 取而不是按 桶+文件名 取】：id 是索引表的主键，对应的路径由
   * 数据库给出、不来自用户输入，天然没有穿越问题。若做成
   * /api/library/:bucket/:filename，filename 就成了外部输入，
   * 又得再加一道校验——能不引入外部输入就不引入。
   *
   * 带 Range：BGM 是几十 MB 的 wav，不支持区间请求的话，
   * 用户拖一下进度条就得等整首下完。
   */
  app.get<{ Params: { id: string } }>(
    '/api/library/items/:id', { preHandler: requireAuth }, async (req, reply) => {
      const db = openLibraryDb(dataDir)
      let item
      try {
        item = getLibraryItem(db, req.params.id)
      } finally {
        db.close()
      }
      if (item === null) return reply.code(404).send({ error: '素材不存在' })

      const path = libraryItemPath(dataDir, item)
      let size: number
      try {
        size = (await stat(path)).size
      } catch {
        return reply.code(404).send({ error: '素材文件已丢失' })
      }

      reply.header('Content-Type', playbackMimeFor(path))
      reply.header('Accept-Ranges', 'bytes')
      // 素材库是只读的公共资源，内容不会变，可以长缓存
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')

      const range = parseRange(req.headers.range, size)
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${size}`)
        return reply.code(416).send({ error: '请求的字节区间超出文件范围' })
      }
      if (range !== null) {
        reply.code(206)
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        reply.header('Content-Length', range.end - range.start + 1)
        return reply.send(createReadStream(path, { start: range.start, end: range.end }))
      }
      reply.header('Content-Length', size)
      return reply.send(createReadStream(path))
    })
}
