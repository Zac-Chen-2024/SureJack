/**
 * 背景轨【提前拼好】。
 *
 * ── 为什么现在做得起 ────────────────────────────────────────────────
 * 素材归一化之后，切片从"解码重编码"变成"搬压缩帧"（见 build.ts 的
 * copySegmentArgs）。实测一条 60 秒排布里纯拷贝的两段只花 1.22 秒。
 * 拼背景轨因此从"半小时的大工程"变成"十几秒的后台小活"，可以在配音
 * 一就绪时就做掉，而不是等到用户点导出。
 *
 * ── 换来两件事 ──────────────────────────────────────────────────────
 * 1. 导出时背景轨已经在盘上，直接用，那一段耗时归零
 * 2. 预览里能看到【真实的背景】，而不是一句"成片里会有"
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────────
 * 1. **复用导出那条串行队列**，不另起并发。机器 4 核，ffmpeg 本来就吃满
 *    CPU，两条队列只会互相拖慢（设计文档第 12 节）。
 * 2. **排布变了要重拼**。扫进新素材会改变已有项目的排布（background.ts
 *    里记着这个已知取舍）。存一个指纹，对不上就重来。
 * 3. **失败绝不能阻断导出**。这整条路径是个优化；它没成功时导出必须
 *    照旧走即时生成。所以这里的读取路径一律吞异常回 null，
 *    让调用方回退，而不是把错误往上抛。
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb, type Project } from '../db/user-db.js'
import { assetDir } from '../assets/storage.js'
import { openLibraryDb } from '../library/library-db.js'
import { hasVideoMaterials, planProjectBackground, type BgSegment } from '../library/background.js'
import { aspectOf } from '../subtitles/project-ass.js'
import { buildBackgroundTrack } from './build.js'
import { reusableOutput, writeStamp as writeStampFile } from './stamp.js'
import type { ExportQueue } from '../queue/queue.js'
import type { AspectPreset } from '../types.js'

/** 背景轨的文件名。导出和预拼落在同一个位置，谁先做完都算数。 */
export const BG_TRACK_FILE = 'bg-track.mp4'

/**
 * 指纹旁挂文件。**不加 DB 列**——线上库要迁移，而这就是一行元数据。
 *
 * 读写落在共用的 stamp.ts 上：成片（export.json）用的是同一套机制，
 * 两份产物各有各的文件，但**判"还能不能用"的规则只有一份**。
 */
export const BG_STAMP_FILE = 'bg-track.json'

/**
 * 排布指纹。
 *
 * 【分隔符不能省】：素材 id 是「桶名/文件名」，直接串起来的话
 * ('ab', 1) 和 ('a', 'b1') 会撞成同一个指纹，然后用户拿到一条陈旧的轨，
 * 而且没有任何症状能让人想到是指纹撞了。
 *
 * 【画幅要算进去】：排布一模一样，但 9:16 拼好的轨拿去当 1:1 的背景，
 * 整个画面比例是错的。
 */
export function planFingerprint (
  segments: readonly BgSegment[], aspect: AspectPreset,
): string {
  const body = segments
    .map((s) => `${s.itemId}\0${s.startMs}\0${s.takeMs}`)
    .join('')
  return createHash('sha256')
    .update(`${aspect.width}x${aspect.height}${segments.length}${body}`)
    .digest('hex')
}

/**
 * 这个项目的预拼作业 id。
 *
 * 带 `bgtrack:` 前缀，和导出作业的 UUID 在结构上不可能撞车——撞了的话
 * 一次预拼会把用户正盯着的导出进度条覆盖掉。
 */
export function bgTrackJobId (projectId: string): string {
  return `bgtrack:${projectId}`
}

/** 记下这条轨是按哪份排布拼的 */
export async function writeStamp (dir: string, fingerprint: string): Promise<void> {
  await writeStampFile(dir, BG_STAMP_FILE, { fingerprint, status: 'done' })
}

/**
 * 现成的轨还能不能用。能用返回路径，不能用返回 null。
 *
 * ⚠️【永远不抛】。调用方（导出）只把它当成一个"能省则省"的问句；
 * 一个读不出来的旁挂文件不该让用户导不出片子。
 */
export async function reusableBgTrack (
  dir: string, fingerprint: string,
): Promise<string | null> {
  return reusableOutput(dir, BG_STAMP_FILE, BG_TRACK_FILE, fingerprint)
}

export interface PrebuildDeps {
  whitelist: string[]
  queue: ExportQueue
  /** 素材库所在的 data 根目录（全局公用，不经过 userDbDir） */
  libraryDataDir: string
}

/** 预拼状态。前端只认这四个词。 */
export type BgTrackState = 'none' | 'building' | 'ready' | 'error'

export interface BgTrackInfo {
  state: BgTrackState
  /** 拼好了才有。前端用 `/api/assets/<id>` 取这条轨 */
  assetId: string | null
}

/**
 * 算出这个项目当前该有的排布 + 指纹。
 *
 * 配音没好、素材库空 → 返回 null，那都是正常的"还没到时候"，不是错误。
 */
function currentPlan (
  deps: PrebuildDeps, project: Project,
): { segments: BgSegment[]; fingerprint: string; aspect: AspectPreset } | null {
  if (project.ttsDurationMs === null || project.ttsDurationMs <= 0) return null

  const lib = openLibraryDb(deps.libraryDataDir)
  try {
    if (!hasVideoMaterials(lib)) return null
    const aspect = aspectOf(project)
    const plan = planProjectBackground(lib, project.id, project.ttsDurationMs)
    if (plan.segments.length === 0) return null
    return { segments: plan.segments, fingerprint: planFingerprint(plan.segments, aspect), aspect }
  } finally {
    lib.close()
  }
}

/** 把这条轨登记成素材，前端才能通过 `/api/assets/<id>` 播它 */
function registerTrackAsset (
  deps: PrebuildDeps, userName: string, projectId: string, path: string, durationMs: number,
): void {
  const db = openUserDb(userName, deps.whitelist)
  try {
    /*
     * ⚠️【已有记录就地更新，绝不删了重插】。
     *
     * 这条轨的 id 会被别人【拿在手里】：前端的 <video src="/api/assets/<id>">
     * 一旦拿到就一直用着。删了重插会换一个新 id，于是那个正在播的 URL
     * 当场 404——而重新登记是后台自己发生的，用户什么都没做，
     * 画面就黑了。
     *
     * 同一条轨永远写在同一个路径（BG_TRACK_FILE），本来就该是同一条记录。
     * 之前用删+插的写法还让测试随机 404：先读到 id，再取素材，
     * 中间只要有另一条预拼作业完成，手里那个 id 就没了。
     *
     * 多于一条是不该出现的历史脏数据，留第一条、其余清掉。
     */
    const [existing, ...extra] = db.listAssets(projectId, 'bgtrack')
    for (const a of extra) db.deleteAsset(a.id)

    if (existing !== undefined) {
      db.updateAsset(existing.id, { path, durationMs })
    } else {
      db.addAsset({
        projectId, kind: 'bgtrack', path,
        originalName: BG_TRACK_FILE, size: 0, durationMs,
      })
    }
  } finally {
    db.close()
  }
}

/**
 * 真正拼。跑在队列里，所以【一次只有一条 ffmpeg 管线在动】。
 *
 * 排布在这里现算而不是入队时算：从入队到真正执行之间可能排着一条导出，
 * 那几分钟里素材库完全可能被扫过一遍。用执行那一刻的排布才对得上。
 */
async function runBgTrackBuild (
  deps: PrebuildDeps, userName: string, projectId: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const db = openUserDb(userName, deps.whitelist)
  let project
  try { project = db.getProject(projectId) } finally { db.close() }
  if (!project) throw new Error('项目不存在')

  const cur = currentPlan(deps, project)
  if (cur === null) throw new Error('还算不出背景排布——确认配音已就绪、素材库已扫描')

  const dir = assetDir(userName, deps.whitelist, projectId)
  const durationMs = Math.round(project.ttsDurationMs ?? 0)

  // 已经有一条对得上的：登记一下就完事，别白拼一遍
  const reuse = await reusableBgTrack(dir, cur.fingerprint)
  if (reuse !== null) {
    registerTrackAsset(deps, userName, projectId, reuse, durationMs)
    onProgress(100)
    return reuse
  }

  await mkdir(dir, { recursive: true })
  const outPath = join(dir, BG_TRACK_FILE)
  await buildBackgroundTrack({
    segments: cur.segments, dataDir: deps.libraryDataDir,
    aspect: cur.aspect, outPath, workRoot: dir, onProgress,
  })
  /*
   * 【先有完整文件，再写指纹】。反过来的话，拼到一半被杀会留下
   * "指纹对得上但文件是半个"的状态，而那正是最难发现的一类坏数据。
   */
  await writeStamp(dir, cur.fingerprint)
  registerTrackAsset(deps, userName, projectId, outPath, durationMs)
  return outPath
}

/**
 * 配音就绪后调它。入队，立刻返回——**绝不 await**。
 *
 * 幂等：已经排着一条还没开跑的，就不用再排一条了（它的 runner 会在
 * 执行时现算排布，拿到的就是最新的）。
 */
export function enqueueBgTrack (
  deps: PrebuildDeps, userName: string, projectId: string,
): void {
  const jobId = bgTrackJobId(projectId)
  if (deps.queue.snapshot(jobId)?.status === 'queued') return
  deps.queue.enqueue(jobId, (onProgress) =>
    runBgTrackBuild(deps, userName, projectId, onProgress))
}

/**
 * 预览要问的那句：背景轨现在什么情况。
 *
 * 【顺手补拼】：状态是 none 但排布明明算得出来（比如这个项目的配音是
 * 上线前生成的，没触发过预拼），就在这里入队。前端问一次状态就够了，
 * 用户不需要知道"得先重新生成一次配音"这种内部规矩。
 */
export async function bgTrackInfo (
  deps: PrebuildDeps, userName: string, projectId: string,
): Promise<BgTrackInfo> {
  const db = openUserDb(userName, deps.whitelist)
  let project
  let asset
  try {
    project = db.getProject(projectId)
    asset = project === null ? null : db.listAssets(projectId, 'bgtrack')[0] ?? null
  } finally {
    db.close()
  }
  if (!project) return { state: 'none', assetId: null }

  let cur: ReturnType<typeof currentPlan> = null
  try {
    cur = currentPlan(deps, project)
  } catch {
    // 素材库读不出来：说"没有"，别把预览搞成红色报错
    return { state: 'none', assetId: null }
  }
  if (cur === null) return { state: 'none', assetId: null }

  const dir = assetDir(userName, deps.whitelist, projectId)
  if (asset !== null && await reusableBgTrack(dir, cur.fingerprint) !== null) {
    return { state: 'ready', assetId: asset.id }
  }

  const snap = deps.queue.snapshot(bgTrackJobId(projectId))
  if (snap?.status === 'queued' || snap?.status === 'running') {
    return { state: 'building', assetId: null }
  }
  if (snap?.status === 'error') return { state: 'error', assetId: null }

  // 算得出排布、盘上却没有、队列里也没有 → 现在补一条
  enqueueBgTrack(deps, userName, projectId)
  return { state: 'building', assetId: null }
}
