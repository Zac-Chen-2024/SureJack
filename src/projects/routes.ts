import type { FastifyInstance } from 'fastify'
import { openUserDb } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { openLibraryDb } from '../library/library-db.js'
import { hasVideoMaterials, planProjectBackground } from '../library/background.js'

interface Deps {
  whitelist: string[]
  /** 素材库所在的 data 根目录（全局公用，不经过 userDbDir） */
  libraryDataDir: string
}

/**
 * 项目 CRUD。
 *
 * ⚠️ 每个 handler 都用会话身份打开【那个人自己的库】——
 * openUserDb(name, whitelist) 只收姓名，路径由白名单映射唯一确定。
 * 所以这里没有、也不需要任何 `WHERE owner = ?`：
 * 打开的库本身就是那个人的，跨用户读取在结构上不可能发生。
 *
 * 每次请求开库/关库：SQLite 打开极快（微秒级），2 用户场景下
 * 比维护连接池简单得多，且天然避免了"连接绑错用户"这类 bug。
 */
export function registerProjectRoutes (app: FastifyInstance, deps: Deps): void {
  const { whitelist, libraryDataDir } = deps

  /** 用当前会话身份开库，跑一段逻辑，然后必定关库 */
  function withUserDb<T> (name: string, fn: (db: ReturnType<typeof openUserDb>) => T): T {
    const db = openUserDb(name, whitelist)
    try { return fn(db) } finally { db.close() }
  }

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const name = getSession(req)!
    return withUserDb(name, (db) => db.listProjects())
  })

  app.post<{ Body: { name?: unknown } }>('/api/projects', { preHandler: requireAuth }, async (req, reply) => {
    const projectName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!projectName) return reply.code(400).send({ error: '请填项目名' })
    const name = getSession(req)!
    return withUserDb(name, (db) => db.createProject(projectName))
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const project = withUserDb(name, (db) => db.getProject(req.params.id))
    if (!project) return reply.code(404).send({ error: '项目不存在' })
    return project
  })

  app.patch<{ Params: { id: string }; Body: {
    name?: unknown; scriptText?: unknown; aspectRatio?: unknown
    bgmLibraryId?: unknown; bgmVolume?: unknown
  } }>(
    '/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
      const patch: {
        name?: string; scriptText?: string; aspectRatio?: string
        bgmLibraryId?: string | null; bgmVolume?: number
      } = {}
      if (typeof req.body?.name === 'string') patch.name = req.body.name
      if (typeof req.body?.scriptText === 'string') patch.scriptText = req.body.scriptText
      if (typeof req.body?.aspectRatio === 'string') patch.aspectRatio = req.body.aspectRatio
      /*
       * bgmLibraryId 的 null 是【有意义的值】——"不要 BGM"。所以不能像上面
       * 几个字段那样只认字符串就完事：null 必须原样传下去清库，而其余类型
       * （数字、对象……）一律忽略，不让脏值落库。
       */
      const bgm = req.body?.bgmLibraryId
      if (typeof bgm === 'string' || bgm === null) patch.bgmLibraryId = bgm

      /*
       * bgmVolume：背景音乐相对配音的音量，0..1（导出时经 buildAudioFilter
       * 生效）。**必须钳位**——它会原样进 ffmpeg 的 volume 滤镜，
       * 一个 100 会把整条音轨削爆。NaN/Infinity 也要挡在库外。
       */
      const vol = req.body?.bgmVolume
      if (typeof vol === 'number' && Number.isFinite(vol)) {
        patch.bgmVolume = Math.min(1, Math.max(0, vol))
      }

      const name = getSession(req)!
      const updated = withUserDb(name, (db) => db.updateProject(req.params.id, patch))
      if (!updated) return reply.code(404).send({ error: '项目不存在' })
      return updated
    })

  /**
   * 这个项目的背景轨排布：开头 → 常规 → 地铁跑酷，与配音精确等长。
   *
   * 只读、每次现算，**不落库**——项目只存素材 id 引用，绝不复制素材
   * （地铁跑酷单桶就 4.7GB）。前端拿它画预览条，导出时用同一个函数
   * 算出同一份排布，所见即所得。
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/background-plan', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const project = withUserDb(name, (db) => db.getProject(req.params.id))
      if (!project) return reply.code(404).send({ error: '项目不存在' })

      const lib = openLibraryDb(libraryDataDir)
      try {
        /*
         * 配音未就绪是正常中间态，planProjectBackground 自己回空排布。
         * 但【素材库一条视频都没有】是另一回事——库还没扫过，是个能靠
         * POST /api/library/scan 解决的状态问题。不先判这一下的话，
         * planBackground 会抛错、落到全局错误处理器变成 500「服务器内部
         * 错误」，可操作的原因全被抹掉。用 409 明确说出来。
         */
        if (project.ttsDurationMs !== null && project.ttsDurationMs > 0 && !hasVideoMaterials(lib)) {
          return reply.code(409).send({ error: '素材库里没有可用的视频素材，请先扫描素材库' })
        }
        return planProjectBackground(lib, project.id, project.ttsDurationMs)
      } finally {
        lib.close()
      }
    })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const name = getSession(req)!
    const ok = withUserDb(name, (db) => db.deleteProject(req.params.id))
    if (!ok) return reply.code(404).send({ error: '项目不存在' })
    return { ok: true }
  })
}
