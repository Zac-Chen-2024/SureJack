import { existsSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { ffmpeg, buildBackgroundTrack, concatListContent } from './build.js'
import { readStamp } from './stamp.js'
import { probeDurationMs } from '../render/probe.js'
import { render } from '../render/index.js'
import type { FilmPlan } from './film.js'

const exec = promisify(execFile)

/**
 * 【只重烧开头】。
 *
 * ── 解决什么 ────────────────────────────────────────────────────────
 * 用户看完片子觉得开头几个画面不好看,想换一批。整条重烧要十几分钟
 * (实测 9 分半的片子烧 14 分钟),而真正变了的只有最前面那两分半。
 *
 * ── 怎么做 ──────────────────────────────────────────────────────────
 *   ① `-ss <分界> -c copy` 从盘上那条母带切下后半段    几秒,无损
 *   ② 只烧新的开头(约占全片 27%)                      约 2 分钟
 *   ③ concat `-c copy` 拼回去                          几秒,无损
 *
 * 后半段一个像素都没重新编码——它就是原来那条母带的后半截。
 *
 * ── ⚠️ 三道闸,少一道就会拼出坏片子 ─────────────────────────────────
 * 1. **当初那条母带真的强制过关键帧**(`keyframeForced`)。`-c copy` 只能从
 *    关键帧起,没有那一帧 ffmpeg 会悄悄退到前一个关键帧、把整条都搬进
 *    "后半段",再用 edit list 把起点标到分界——**时长元数据仍然正确**,
 *    实测拼出来多了 225 帧(7.5 秒的旧开头),而 ffprobe 一切正常。
 * 2. **分界没挪过**。后半段是从那一毫秒切下来的,分界一变它的起点就
 *    对不上新的时间轴。
 * 3. **后半段的指纹没变**。字幕/配音/时长/画幅任一变化都会让它变,
 *    那时候后半段本身就该重烧,拼旧的等于发一条前后对不上的片子。
 *
 * 任何一道过不去就返回 false,调用方回到整条重烧那条老路——**慢十几分钟,
 * 但永远正确**。这条路径的每一次"不确定"都必须倒向重烧。
 */

/** 中间产物。都写在项目目录里,失败也就地清掉 */
const HEAD_TRACK = 'head-track.mp4'
const HEAD_FILE = 'head.partial.mp4'
const TAIL_FILE = 'tail.partial.mp4'
const LIST_FILE = 'reopen-list.txt'

/** 一帧的毫秒数(30fps)。拼接后的时长允许差这么多 */
const FRAME_MS = 1000 / 30

export interface SwapPlan {
  boundaryMs: number
  /** 开头包含排布的前几段 */
  headSegmentCount: number
}

/**
 * 盘上那条母带能不能只换开头。
 *
 * ⚠️【永远不抛】。它只是个"能省则省"的问句,读不出旁挂文件、母带不在了、
 * 指纹对不上——统统回 null,调用方整条重烧。
 */
export async function planHeadSwap (dir: string, f: FilmPlan): Promise<SwapPlan | null> {
  try {
    if (f.split === null) return null                      // 这条片子本来就不支持
    if (f.plan === null) return null                       // 自备背景视频,没有"开头那几段"
    if (!existsSync(join(dir, 'master.mp4'))) return null   // 母带都不在,没得切

    const stamp = await readStamp(dir, 'master.json')
    if (stamp === null) return null
    if (stamp.status !== undefined && stamp.status !== 'done') return null
    /*
     * ⚠️ 这三条【必须全中】。readStamp 已经保证这几项要么整组都在、
     * 要么整组都没有(见 stamp.ts),这里再逐条比一次。
     */
    if (stamp.keyframeForced !== true) return null
    if (stamp.boundaryMs !== f.split.boundaryMs) return null
    if (stamp.tailFingerprint !== f.split.tail) return null
    /* 开头本身没变就不用换——调用方那边母带指纹会直接命中复用 */
    if (stamp.headFingerprint === f.split.head) return null

    return { boundaryMs: f.split.boundaryMs, headSegmentCount: f.split.headSegmentCount }
  } catch {
    return null
  }
}

/** 第一个视频包是不是关键帧。切完必须验——这是"切干净了"的唯一硬证据 */
async function firstPacketIsKeyframe (path: string): Promise<boolean> {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-read_intervals', '%+#1',
      '-show_entries', 'packet=flags', '-of', 'csv=p=0', path,
    ])
    return stdout.trim().split('\n')[0]?.includes('K') === true
  } catch {
    return false
  }
}

/**
 * 真的换。成功返回 true(新的 master.mp4 已经就位),失败返回 false。
 *
 * ⚠️【失败绝不抛】。这是一条优化路径:它没走通,调用方整条重烧就是了,
 * 用户照样拿到片子,只是多等十几分钟。为一条优化路径让用户拿不到片子
 * 是本末倒置。
 *
 * ⚠️【只在最后一步动 master.mp4】。中间产物全写在旁边,最后一次 rename
 * 才替换——rename 在同一文件系统上是原子的。半路失败时盘上那条旧母带
 * 分毫未动,用户手里的片子始终可播、可下载。
 */
export async function swapHead (
  opts: {
    dir: string
    f: FilmPlan
    plan: SwapPlan
    libraryDataDir: string
    assPath: string
    onProgress: (pct: number) => void
    signal?: AbortSignal
  },
): Promise<boolean> {
  const { dir, f, plan, assPath, onProgress, signal } = opts
  const masterPath = join(dir, 'master.mp4')
  const headTrack = join(dir, HEAD_TRACK)
  const headPath = join(dir, HEAD_FILE)
  const tailPath = join(dir, TAIL_FILE)
  const listPath = join(dir, LIST_FILE)
  const cleanup = async (): Promise<void> => {
    for (const p of [headTrack, headPath, tailPath, listPath]) {
      await rm(p, { force: true }).catch(() => { /* 清不掉顶多占点地方 */ })
    }
  }

  try {
    const wholeMs = await probeDurationMs(masterPath)

    /*
     * ── ① 切后半段 ────────────────────────────────────────────────
     * `-ss` 在 `-i` 【前面】:输入端定位,直接在容器里跳过去。
     * 放后面是输出选项,会从头解码到切点——母带是 458MB。
     */
    await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (plan.boundaryMs / 1000).toFixed(3),
      '-i', masterPath,
      '-c', 'copy',
      tailPath,
    ])
    /*
     * ⚠️【切完必须验第一个包是关键帧】。不验的话,一条没有那一帧的母带
     * 也能"切成功"——ffmpeg 不报错,只是把整条搬了过来。而这个错误要到
     * 用户点开片子才看得见。
     */
    if (!await firstPacketIsKeyframe(tailPath)) {
      await cleanup()
      return false
    }
    const tailMs = await probeDurationMs(tailPath)
    // 后半段应当正好是"整条 − 分界"。差超过一帧说明切点没落在预期的地方
    if (Math.abs(tailMs - (wholeMs - plan.boundaryMs)) > FRAME_MS) {
      await cleanup()
      return false
    }
    onProgress(10)

    /*
     * ── ② 只给开头那几段拼一条背景轨,再烧 ──────────────────────────
     * 整条背景轨 385MB、拼几分钟;开头只占 27%,这一步才是省下来的大头。
     */
    const headSegs = f.plan!.segments.slice(0, plan.headSegmentCount)
    await buildBackgroundTrack({
      segments: headSegs, dataDir: opts.libraryDataDir,
      aspect: f.aspect, outPath: headTrack, workRoot: dir,
      onProgress: (p) => onProgress(10 + p * 0.25),
    })

    await render({
      clips: [{ ...f.clip, path: headTrack }],
      voicePath: f.voicePath,
      silentMaster: true,
      bgmVolume: f.project.bgmVolume,
      assPath, aspect: f.aspect,
      /*
       * ⚠️【正好烧到分界,而且要毫秒精度】。字幕的时间轴是从 0 起的整条,
       * 烧到分界就停,画面和字幕自然都只剩开头那一段。
       * 长一帧的话,后半段整体后移 33 毫秒,字幕就相对配音晚了——
       * 而且是从接缝一直错到片尾。
       */
      durationMs: plan.boundaryMs,
      exactDuration: true,
      outPath: headPath,
    }, (p) => onProgress(35 + p * 0.55), signal)
    onProgress(90)

    /*
     * ── ③ 拼回去 ──────────────────────────────────────────────────
     * 两段的编码参数完全一致(共用 MASTER_VIDEO_ARGS),所以 `-c copy`
     * 只是把流首尾相接,不重新编码。
     */
    await writeFile(listPath, concatListContent([headPath, tailPath]), 'utf-8')
    const joined = `${masterPath}.reopen.mp4`
    await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      joined,
    ])

    /*
     * ⚠️【拼完再验一次总长】。concat 对参数不一致【不一定报错】,可能产出
     * 一个只有前半段能正常播的文件,而时长看着完全正常。总长对不上是这类
     * 故障最容易抓到的信号。
     */
    const joinedMs = await probeDurationMs(joined).catch(() => -1)
    if (Math.abs(joinedMs - wholeMs) > FRAME_MS * 2) {
      await rm(joined, { force: true }).catch(() => {})
      await cleanup()
      return false
    }

    // 最后一步才动母带。到这一刻之前，盘上那条旧的始终完好可播
    await rename(joined, masterPath)
    await cleanup()
    onProgress(100)
    return true
  } catch {
    /*
     * 中断(用户点了「中断」)也走这里。清干净、报 false,调用方那边
     * signal 已经 abort,整条重烧同样会被拦下,不会白烧。
     */
    await cleanup()
    return false
  }
}
