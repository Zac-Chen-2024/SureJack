/**
 * 成片（export.mp4）——【配音一就绪，后台自己合成】。
 *
 * ── 导出不再是一个动作 ──────────────────────────────────────────────
 * 老流程里用户要点「导出视频」，然后盯着进度条等几分钟。可这几分钟里
 * 需要用户做的事是零：文案、配音、字幕、BGM 在他点之前就全定下来了。
 * 那这一步就不该占用他的注意力。配音一好，成片就在后台开始合，界面上
 * 只剩一个「下载视频」。
 *
 * ── 和背景轨的关系：两个产物，各有各的用途，不要合并 ────────────────
 * - `bg-track.mp4`（prebuild.ts）：**无字幕**的背景轨，给【预览】播。
 * - `export.mp4`（这里）：字幕已经烧死 + 混好 BGM 的成片，给【下载】。
 *
 * 预览的 <video> 绝不能指向 export.mp4——字幕烧死了一层，浏览器里
 * JASSUB 还会再渲一层，用户看到的是双重字幕重影。
 *
 * 背景轨是成片的**输入**，顺序不能反。这里靠"队列是 FIFO 串行的"来保证：
 * 排成片之前先排背景轨，排在前面的一定先跑完（见 enqueueFilm）。
 *
 * ── 什么时候作废重做：指纹说了算 ────────────────────────────────────
 * 沿用背景轨那套旁挂指纹（stamp.ts）。把所有影响成片画面/声音的输入
 * 揉成一个 hash 存进 export.json；对不上就重做。**不去挨个路由挂钩子**
 * ——改 BGM、调音量、拖字幕高度、改文案重配音，每一条都要记得触发一次
 * 重合成，漏一条就是"用户改了东西但下载到的还是老片子"，而这种 bug
 * 完全不可自证。指纹是唯一真相：输入变了，指纹自然就变了。
 *
 * ── 失败绝不能把项目卡死 ────────────────────────────────────────────
 * 失败写进 export.json（status=error + 原因），**活过进程重启**。
 * 于是两件事同时成立：
 * 1. 状态接口看到 error 就**不再自动重排** —— 否则一条必然失败的任务
 *    会被无限重跑，四核机器就这么被占死。
 * 2. 用户改了任何输入（指纹变了），或者手动点重试，就照常重来。
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openUserDb, type Project } from '../db/user-db.js'
import { assetDir } from '../assets/storage.js'
import { openLibraryDb } from '../library/library-db.js'
import { getLibraryItem } from '../library/scan.js'
import { libraryItemPath } from '../library/paths.js'
import { hasVideoMaterials, planProjectBackground, type BackgroundPlan } from '../library/background.js'
import { buildAssForProject, aspectOf } from '../subtitles/project-ass.js'
import { render } from '../render/index.js'
import { buildBackgroundTrack } from './build.js'
import {
  BG_TRACK_FILE, enqueueBgTrack, planFingerprint, reusableBgTrack,
  writeStamp as writeBgStamp, type PrebuildDeps,
} from './prebuild.js'
import { readStamp, reusableOutput, writeStamp } from './stamp.js'
import type { AspectPreset, Clip } from '../types.js'

/** 成片文件名。手动导出和后台自动合成落在同一个位置，谁先做完都算数。 */
export const FILM_FILE = 'export.mp4'

/** 成片的指纹旁挂文件 */
export const FILM_STAMP_FILE = 'export.json'

/**
 * 背景轨生成在整条合成进度里占的比重。
 *
 * 拍脑袋定的 30%：一条 13 分钟的成片要截十几段再拼，几分钟起步，
 * 【不能让进度条在这段时间里一动不动】——那和卡死没有区别。
 * 精确的比重取决于素材和机器，也没必要精确：进度条要的是"在动"。
 */
const BG_TRACK_SHARE = 0.3

/** 依赖和预拼完全一样——两者本来就是同一条流水线的两截 */
export type FilmDeps = PrebuildDeps

export interface FilmFingerprintInput {
  aspect: AspectPreset
  durationMs: number
  /** 背景的来源。公式模式是排布指纹，自备视频是那个素材 */
  bgKey: string
  /** ASS 全文。文案、词级时间轴、字幕高度、显示模式全在里面 */
  ass: string
  voicePath: string
  bgmPath: string | null
  bgmVolume: number
}

/**
 * 成片指纹。
 *
 * 【为什么直接哈希 ASS 全文而不是挨个列字段】：ASS 是从项目派生出来的
 * （project-ass.ts），文案、时间轴、字幕高度、整句/逐字模式、画幅全都
 * 已经体现在那几千字节里。列字段的写法每加一个字幕相关的设置就要记得
 * 补一行，漏了就是"改了设置但下载到老片子"。哈希全文不会漏。
 *
 * 【为什么用 JSON.stringify 而不是字符串拼接】：路径里什么字符都可能有。
 * 直接拼的话 ('甲','乙') 和 ('甲乙','') 会撞成同一个指纹，然后用户拿到
 * 一条陈旧的成片，而且没有任何症状能让人想到是指纹撞了。JSON 的数组
 * 编码是无歧义的。
 */
export function filmFingerprint (i: FilmFingerprintInput): string {
  return createHash('sha256').update(JSON.stringify([
    i.aspect.width, i.aspect.height, i.durationMs, i.bgKey,
    createHash('sha256').update(i.ass).digest('hex'),
    i.voicePath, i.bgmPath, i.bgmVolume,
  ])).digest('hex')
}

/** 合成一条成片需要的全部输入，外加它的指纹 */
export interface FilmPlan {
  project: Project
  clip: Clip
  /** 公式模式的排布；null = 用的是上传的背景视频 */
  plan: BackgroundPlan | null
  voicePath: string
  bgmPath: string | null
  ass: string
  aspect: AspectPreset
  durationMs: number
  fingerprint: string
  /** 这个项目的素材目录。成片、背景轨、字幕、指纹都落在这儿 */
  dir: string
}

export type FilmResolution =
  | { ok: true; film: FilmPlan }
  /** missing → 404；blocked → 400。error 是给用户看的话，可以直接显示 */
  | { ok: false; code: 'missing' | 'blocked'; error: string }

/**
 * 算出"现在该合成什么"。**纯读，不落盘、不入队**。
 *
 * 三个调用方共用它，这是「用户点导出得到的片子」和「后台自动合成的片子」
 * 一模一样的唯一保证：
 * - POST /export（手动重新合成）→ 用它的 !ok 分支回 400/404
 * - runFilmBuild（真正干活）→ 在**执行那一刻**再算一次
 * - filmInfo（状态查询）→ 用它的指纹判断盘上那条还算不算数
 *
 * 【执行时现算而不是入队时算】：从入队到真跑之间可能排着别的活，
 * 那几分钟里素材库完全可能被扫过一遍、用户也可能换了 BGM。
 */
export function resolveFilm (
  deps: FilmDeps, userName: string, projectId: string,
): FilmResolution {
  const db = openUserDb(userName, deps.whitelist)
  let snap
  try {
    snap = {
      project: db.getProject(projectId),
      videos: db.listAssets(projectId, 'video'),
      voices: db.listAssets(projectId, 'voice'),
      bgms: db.listAssets(projectId, 'bgm'),
    }
  } finally {
    db.close()
  }

  const project = snap.project
  if (project === null) return { ok: false, code: 'missing', error: '项目不存在' }

  // 阶段 1 划界：多片段需要两趟渲染，尚未实现。显式报错而非悄悄出错。
  if (snap.videos.length > 1) {
    return { ok: false, code: 'blocked', error: '暂时只支持一个背景视频，请删掉多余的' }
  }

  /*
   * 【公式模式】：没有上传的背景视频 → 背景由素材库按三段式公式现拼。
   * 有上传的 → 走原来的单视频路径，行为一字不变。
   */
  const uploaded = snap.videos[0]
  const formulaMode = uploaded === undefined

  const voice = snap.voices[0]
  const durationMs = Math.round(project.ttsDurationMs ?? 0)
  if (voice === undefined || project.ttsState !== 'ready' || durationMs <= 0) {
    /*
     * 配音先判。公式模式下【背景长度完全由配音决定】——没有配音就没有
     * 排布可算，"先传素材"那句老提示在这条路径上已经不成立了。
     */
    return { ok: false, code: 'blocked', error: '还没有配音，先点「生成配音」' }
  }

  // 素材库只在真用得上时才打开：旧路径 + 没选库里的 BGM 时，一次都不该碰它
  let plan: BackgroundPlan | null = null
  let libraryBgmPath: string | null = null
  if (formulaMode || project.bgmLibraryId !== null) {
    const lib = openLibraryDb(deps.libraryDataDir)
    try {
      if (formulaMode) {
        /*
         * 库里一条视频都没有是【能靠扫库解决的状态问题】，必须说清楚。
         * 不先判这一下，planBackground 会在队列里抛错，用户只看到一句
         * ffmpeg 风格的天书。
         */
        if (!hasVideoMaterials(lib)) {
          return { ok: false, code: 'blocked', error: '素材库里没有可用的视频素材，请先扫描素材库' }
        }
        plan = planProjectBackground(lib, project.id, durationMs)
        if (plan.segments.length === 0) {
          return { ok: false, code: 'blocked', error: '算不出背景排布，请确认配音时长和素材库' }
        }
      }
      if (project.bgmLibraryId !== null) {
        /*
         * 选中的 BGM 被从库里删掉了：不混 BGM 继续合成，别让整条成片失败。
         * 成片没有背景音乐是看得见的，比根本下载不到好收拾。
         */
        const item = getLibraryItem(lib, project.bgmLibraryId)
        if (item !== null) libraryBgmPath = libraryItemPath(deps.libraryDataDir, item)
      }
    } finally {
      lib.close()
    }
  }

  const dir = assetDir(userName, deps.whitelist, projectId)
  const aspect = aspectOf(project)
  /*
   * ⚠️ 必须走共用的 buildAssForProject——预览接口调的是同一个函数，
   * 这是「预览即成片」的唯一保证。不要在这里另起一套构造逻辑。
   */
  const ass = buildAssForProject(project)

  let clip: Clip
  let bgKey: string
  if (plan !== null) {
    /*
     * fitMode 用 cover 而不是 blur：这条轨已经在 buildBackgroundTrack 里
     * 归一化到目标画幅了，cover 在这里是恒等变换。用 blur 会白白多做一遍
     * 高斯模糊叠底，纯浪费 CPU。
     */
    clip = { path: join(dir, BG_TRACK_FILE), fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }
    /*
     * 【背景轨的路径是固定的】（永远是 bg-track.mp4），所以指纹里绝不能
     * 只放路径——排布换了路径一个字都不变，成片就永远不会被判作废。
     * 要放的是排布本身的指纹。
     */
    bgKey = `plan:${planFingerprint(plan.segments, aspect)}`
  } else if (uploaded !== undefined) {
    clip = { path: uploaded.path, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }
    bgKey = `upload:${uploaded.id}:${uploaded.path}`
  } else {
    // 上面的分支保证走不到这里；真到了就是逻辑漏洞，明着说出来
    return { ok: false, code: 'blocked', error: '既没有上传的背景视频，也没有可用的背景排布' }
  }

  const bgmPath = libraryBgmPath ?? snap.bgms[0]?.path ?? null
  const fingerprint = filmFingerprint({
    aspect, durationMs, bgKey, ass,
    voicePath: voice.path, bgmPath, bgmVolume: project.bgmVolume,
  })

  return {
    ok: true,
    film: {
      project, clip, plan, voicePath: voice.path, bgmPath, ass,
      aspect, durationMs, fingerprint, dir,
    },
  }
}

/** 把成片登记成素材，列表和历史记录才看得见它 */
function registerFilmAsset (
  deps: FilmDeps, userName: string, projectId: string,
  path: string, durationMs: number, originalName: string,
): void {
  const db = openUserDb(userName, deps.whitelist)
  try {
    /*
     * 旧记录先清掉。**只删记录不删文件**——新成片就写在同一个路径上，
     * 删文件等于把刚合好的东西删了。
     */
    for (const a of db.listAssets(projectId, 'export')) db.deleteAsset(a.id)
    db.addAsset({ projectId, kind: 'export', path, originalName, size: 0, durationMs })
  } finally {
    db.close()
  }
}

/** 真正合。跑在队列里，所以【一次只有一条 ffmpeg 管线在动】。 */
async function buildFilm (
  deps: FilmDeps, userName: string, projectId: string, jobId: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const r = resolveFilm(deps, userName, projectId)
  if (!r.ok) throw new Error(r.error)
  const f = r.film
  const outPath = join(f.dir, FILM_FILE)

  // 已经有一条对得上的：登记一下就完事，别白合一遍
  const reuse = await reusableOutput(f.dir, FILM_STAMP_FILE, FILM_FILE, f.fingerprint)
  if (reuse !== null) {
    registerFilmAsset(deps, userName, projectId, reuse, f.durationMs, `${f.project.name}.mp4`)
    onProgress(100)
    return reuse
  }

  /*
   * 【指纹要在开工时就落盘】，哪怕这一趟最后失败了。
   * 失败时要记下"失败的是哪一份输入"——不然用户改了 BGM 之后，
   * 状态接口无从判断该不该重试，只能要么永远卡在 error、要么无限重排。
   */
  await writeStamp(f.dir, FILM_STAMP_FILE, {
    fingerprint: f.fingerprint, status: 'building', jobId,
  })

  await mkdir(f.dir, { recursive: true })
  const assPath = join(f.dir, 'subtitle.ass')
  await writeFile(assPath, f.ass, 'utf-8')

  /*
   * 公式模式：先要一条与配音等长的无声背景轨，再当作【单个背景视频】
   * 进现有烧录管线——烧录那一侧一行都不用改。
   *
   * 正常情况下这条轨在配音就绪时就已经拼好了（prebuild.ts），这里
   * 直接命中缓存、耗时归零。⚠️ reusableBgTrack【永远不抛】：预拼没成功、
   * 指纹文件读不出来、素材库被扫过导致排布变了——统统回 null，落到下面
   * 即时生成这条老路。用户绝不该因为一个后台优化没做成就拿不到片子。
   */
  if (f.plan !== null) {
    const bgFingerprint = planFingerprint(f.plan.segments, f.aspect)
    if (await reusableBgTrack(f.dir, bgFingerprint) === null) {
      await buildBackgroundTrack({
        segments: f.plan.segments, dataDir: deps.libraryDataDir,
        aspect: f.aspect, outPath: f.clip.path, workRoot: f.dir,
        onProgress: (p) => onProgress(p * BG_TRACK_SHARE),
      })
      // 这次现拼的也记上指纹，下次合成/预览就能直接用
      await writeBgStamp(f.dir, bgFingerprint).catch(() => { /* 记不上顶多下次重拼 */ })
    } else {
      // 跳过了就把这一段进度直接补满，别让进度条从 30% 起跳看着像卡过
      onProgress(BG_TRACK_SHARE * 100)
    }
  }

  await render({
    clips: [f.clip],
    voicePath: f.voicePath,
    bgmPath: f.bgmPath ?? undefined,
    bgmVolume: f.project.bgmVolume,
    assPath, aspect: f.aspect, durationMs: f.durationMs, outPath,
  }, f.plan === null
    ? onProgress
    // 背景轨已经吃掉前 BG_TRACK_SHARE，烧录只推进剩下那一段
    : (p) => onProgress(BG_TRACK_SHARE * 100 + p * (1 - BG_TRACK_SHARE)))

  /*
   * 【先有完整文件，再写 done】。反过来的话，合到一半被杀会留下
   * "指纹对得上但文件是半个"的状态，而那正是最难发现的一类坏数据。
   */
  await writeStamp(f.dir, FILM_STAMP_FILE, { fingerprint: f.fingerprint, status: 'done', jobId })
  registerFilmAsset(deps, userName, projectId, outPath, f.durationMs, `${f.project.name}.mp4`)
  return outPath
}

/** 合 + 把失败原因写进指纹文件。失败照旧往上抛，队列要据此置 error。 */
async function runFilmBuild (
  deps: FilmDeps, userName: string, projectId: string, jobId: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const dir = assetDir(userName, deps.whitelist, projectId)
  try {
    return await buildFilm(deps, userName, projectId, jobId, onProgress)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    /*
     * 保留已经落盘的那份指纹（buildFilm 开工时写的）。它标着"失败的是
     * 哪一份输入"，用户改了任何输入之后指纹自然对不上，就会重新排队。
     */
    const fingerprint = (await readStamp(dir, FILM_STAMP_FILE))?.fingerprint ?? ''
    await writeStamp(dir, FILM_STAMP_FILE, {
      fingerprint, status: 'error', error: message, jobId,
    }).catch(() => { /* 连失败都记不下来，那就当没做过，下次重来 */ })
    throw e
  }
}

/** 队列里这条作业还在跑吗。跑完/失败/根本没有 → null */
async function inFlightJobId (deps: FilmDeps, dir: string): Promise<string | null> {
  const jobId = (await readStamp(dir, FILM_STAMP_FILE))?.jobId
  if (jobId === undefined) return null
  /*
   * 【必须问队列而不是问 DB】。DB 里一条 running 的作业可能是上次进程
   * 被杀时留下的，问 DB 会认为它永远在跑，项目就此卡死。队列是进程内的，
   * 查不到 = 这个进程没在跑它 = 可以重排。
   */
  const status = deps.queue.snapshot(jobId)?.status
  return status === 'queued' || status === 'running' ? jobId : null
}

/**
 * 排一条成片。返回作业 id；条件还不满足（没配音等）时返回 null。
 *
 * 幂等：已经有一条在排队/在跑就直接返回它的 id，不再排第二条。
 * 这一条很重要——状态接口每 2 秒问一次，没有这个闸门的话拖一次字幕
 * 高度滑块就能往队列里灌进几十条渲染。
 *
 * `force` 只给「手动重新合成」用：用户偶尔需要不问指纹强制重来。
 */
export async function enqueueFilm (
  deps: FilmDeps, userName: string, projectId: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const r = resolveFilm(deps, userName, projectId)
  /*
   * 条件不满足就【什么都不做】，不要排一条注定失败的作业。排了的话
   * 用户会在界面上看到一条红色的"合成失败：还没有配音"——那不是失败，
   * 那是还没到时候，两者必须长得不一样。
   */
  if (!r.ok) return null

  const dir = r.film.dir
  if (opts.force !== true) {
    const running = await inFlightJobId(deps, dir)
    if (running !== null) return running
  }

  /*
   * 【背景轨要排在成片前面】。它是成片的输入，而队列是 FIFO 串行的——
   * 先 enqueue 的一定先跑完，顺序就此保证，不需要额外的编排。
   *
   * enqueueBgTrack 自己是幂等的；已经拼好时它的 runner 命中指纹缓存直接
   * 返回。失败也不管：buildFilm 里有即时生成那条回退路。
   */
  try {
    enqueueBgTrack(deps, userName, projectId)
  } catch { /* 预拼是优化，排不上不该挡住成片 */ }

  const db = openUserDb(userName, deps.whitelist)
  let jobId: string
  try { jobId = db.createJob(projectId).id } finally { db.close() }

  // 队列事件同步落库，让刷新页面后还能看到结果
  deps.queue.on(jobId, (e) => {
    const d = openUserDb(userName, deps.whitelist)
    try {
      d.updateJob(jobId, {
        status: e.status === 'queued' ? 'queued' : e.status,
        progress: e.progress,
        error: e.error,
        outputPath: e.outputPath,
      })
    } catch { /* 记不上进度不该影响真正在跑的合成 */ } finally {
      d.close()
    }
  })

  deps.queue.enqueue(jobId, (onProgress) =>
    runFilmBuild(deps, userName, projectId, jobId, onProgress))
  return jobId
}

/** 成片状态。前端只认这四个词。 */
export type FilmState = 'none' | 'building' | 'ready' | 'error'

export interface FilmInfo {
  state: FilmState
  /** 想看细粒度进度时拿它去订 /api/jobs/:jobId/stream */
  jobId: string | null
  progress: number
  /** state=error 时的原因，直接显示给用户 */
  error: string | null
  /** state=none 时还缺什么，直接显示给用户 */
  reason: string | null
}

/**
 * 「下载视频」那个按钮要问的唯一一句话。
 *
 * 【这个接口会顺手补合】：状态是"该有却没有"时就地入队。配音是上线前
 * 生成的老项目、改了 BGM 让老成片作废、上次进程被杀留下半成品——
 * 前端问一次状态就够了，用户不需要知道这些内部规矩。
 *
 * 【但 error 绝不自动重排】：一条必然失败的作业被无限重跑会把四核机器
 * 占死，而用户看到的只是一个永远转圈的按钮。要重试就得他自己点，
 * 或者他改了某个输入让指纹变了——那说明失败的前提已经不成立了。
 */
/**
 * 一个项目的成片【现在处于哪一档】，不含任何副作用。
 *
 * 抽出来是因为有两个调用方要用同一套判定：前端问状态的 filmInfo，
 * 和启动时的补合扫描 sweepFilms。两边各写一遍的话迟早会漂——
 * 尤其是"失败过的不自动重排"这条，漏在扫描里就会变成开机跑一堆
 * 注定失败的 ffmpeg。
 */
type FilmVerdict =
  | { kind: 'blocked'; reason: string }
  | { kind: 'running'; jobId: string; progress: number }
  | { kind: 'ready'; jobId: string | null }
  | { kind: 'failed'; jobId: string | null; error: string }
  /** 该有却没有 —— 唯一需要排活的一档 */
  | { kind: 'missing' }

async function judgeFilm (
  deps: FilmDeps, userName: string, projectId: string,
): Promise<FilmVerdict> {
  let r: FilmResolution
  try {
    r = resolveFilm(deps, userName, projectId)
  } catch {
    // 素材库读不出来之类：说"还不能合"，别把界面搞成红色报错
    return { kind: 'blocked', reason: '暂时算不出成片需要的素材排布，稍后再试' }
  }
  if (!r.ok) return { kind: 'blocked', reason: r.error }

  const { dir, fingerprint } = r.film
  const stamp = await readStamp(dir, FILM_STAMP_FILE)
  const jobId = stamp?.jobId ?? null
  const snap = jobId === null ? null : deps.queue.snapshot(jobId)

  /*
   * 【在跑就先说在跑】，哪怕指纹已经对不上了。那条作业是在执行的那一刻
   * 现算输入的（resolveFilm），大概率已经把新设置吃进去了；就算没有，
   * 它跑完之后下一次轮询会发现指纹不符，再排一条。硬要在这里插队重排
   * 只会让两条 ffmpeg 抢同一个输出文件。
   *
   * ⚠️ 判「在跑」认的是【队列里真有这条作业】，不是戳上写着 building。
   * 进程被杀时戳会永远停在 building，只信戳的话那个项目就再也醒不过来了——
   * 线上真出过：重启一次，成片卡在 11MB 再没动过。
   */
  if (snap?.status === 'queued' || snap?.status === 'running') {
    return { kind: 'running', jobId: jobId!, progress: snap.progress }
  }

  if (await reusableOutput(dir, FILM_STAMP_FILE, FILM_FILE, fingerprint) !== null) {
    return { kind: 'ready', jobId }
  }

  // 失败的正是【当前这份输入】→ 停在这儿等用户重试
  if (stamp?.status === 'error' && stamp.fingerprint === fingerprint) {
    return { kind: 'failed', jobId, error: stamp.error ?? '合成失败' }
  }

  return { kind: 'missing' }
}

export async function filmInfo (
  deps: FilmDeps, userName: string, projectId: string,
): Promise<FilmInfo> {
  const v = await judgeFilm(deps, userName, projectId)
  switch (v.kind) {
    case 'blocked':
      return { state: 'none', jobId: null, progress: 0, error: null, reason: v.reason }
    case 'running':
      return { state: 'building', jobId: v.jobId, progress: v.progress, error: null, reason: null }
    case 'ready':
      return { state: 'ready', jobId: v.jobId, progress: 100, error: null, reason: null }
    case 'failed':
      return { state: 'error', jobId: v.jobId, progress: 0, error: v.error, reason: null }
    case 'missing': {
      // 该有却没有 → 现在排一条
      const newJobId = await enqueueFilm(deps, userName, projectId)
      if (newJobId === null) {
        return { state: 'none', jobId: null, progress: 0, error: null, reason: '暂时还不能合成成片' }
      }
      return { state: 'building', jobId: newJobId, progress: 0, error: null, reason: null }
    }
  }
}

/** sweepFilms 的战果，给日志用 */
export interface SweepResult {
  /** 排上了活的 项目名 */
  enqueued: string[]
  /** 看过但不需要动的项目数 */
  skipped: number
}

/**
 * 【开机补合】：把"该有成片却没有"的项目排上队。
 *
 * 为什么必须有这么个东西：合成是在【配音就绪那一刻】触发的，队列又活在
 * 进程内存里。于是进程一重启，正在跑的作业凭空消失，而没有任何事件会
 * 再次发生——那个项目就永远停在半成品上。在补上这一扫之前，它只能靠
 * 用户碰巧打开页面、前端轮询 /film 顺手补合来救。「自动合成」不该
 * 取决于有没有人在看。
 *
 * 【只补 missing 那一档】。ready 不重做，failed 不自动重试（那条规则在
 * judgeFilm 里，和界面共用一份），blocked 本来就还没到时候。所以开机
 * 最多只会跑真正缺的那几条。
 *
 * 【绝不抛】。这是启动路径上的旁支，某个用户的库坏了不该让整个服务起不来。
 */
export async function sweepFilms (
  deps: FilmDeps, userNames: string[],
): Promise<SweepResult> {
  const out: SweepResult = { enqueued: [], skipped: 0 }

  for (const userName of userNames) {
    let projects: { id: string; name: string }[]
    try {
      const db = openUserDb(userName, deps.whitelist)
      // 没建过项目的用户会在这里开出一个空库，正常
      try { projects = db.listProjects().map((p) => ({ id: p.id, name: p.name })) } finally { db.close() }
    } catch { continue }

    for (const p of projects) {
      try {
        const v = await judgeFilm(deps, userName, p.id)
        if (v.kind !== 'missing') { out.skipped += 1; continue }
        const jobId = await enqueueFilm(deps, userName, p.id)
        if (jobId === null) out.skipped += 1
        else out.enqueued.push(p.name)
      } catch { out.skipped += 1 }
    }
  }
  return out
}

/** 成片文件现在能不能下载。能就给路径。⚠️ 永远不抛。 */
export async function downloadableFilm (
  deps: FilmDeps, userName: string, projectId: string,
): Promise<string | null> {
  const dir = assetDir(userName, deps.whitelist, projectId)
  const stamp = await readStamp(dir, FILM_STAMP_FILE)
  if (stamp === null) return null
  /*
   * 【只看 status，不比指纹】。指纹对不上说明"有更新的版本正在合"，
   * 但盘上这条是完整的、能播的。这时候把下载按钮变成 404 是在惩罚用户
   * ——他刚点了下载而已。按钮该显示什么由 filmInfo 决定，这个接口只
   * 负责"有完整文件就给"。
   */
  if (stamp.status !== undefined && stamp.status !== 'done') return null
  return reusableOutput(dir, FILM_STAMP_FILE, FILM_FILE, stamp.fingerprint)
}
