import { existsSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { ffmpeg, buildBackgroundTrack, concatListContent } from './build.js'
import { readStamp } from './stamp.js'
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

/** 母带的帧率。和 render/ffmpeg.ts 的 `-r 30` 一致 */
const FPS = 30

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

/** 数视频包。**判断切得对不对只能靠它**,见 countPackets 的调用处 */
async function countPackets (path: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-select_streams', 'v', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
  ], { maxBuffer: 1 << 20 })
  const n = Number(stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error(`数不出视频包：${path}`)
  return n
}

/**
 * 【真正能切的那一刀在哪儿】。返回分界【当时那一帧或之后】第一个关键帧的时刻,秒。
 *
 * ⚠️【绝不能直接拿分界去切】。烧录时 `-force_key_frames 5.960` 并不会在 5.960
 * 放一帧——它在【第一个 pts ≥ 5.960 的帧】上放,30fps 下那是 5.966667。
 * 而 `-ss 5.960 -c copy` 找的是"不晚于 5.960 的关键帧",于是退回到 0.000,
 * 把【整条片子】都当成后半段搬走。
 *
 * 实测过一次:分界 5.960 秒的片子,拼出来 779 帧(应该 600),多的正好是
 * 一整段旧开头——而 ffprobe 报的时长是 20.001 秒,看着完全正常。
 *
 * （早先在 7.500 秒上试过一次是好的:那个数正好落在 30fps 的帧网格上,
 * 关键帧就在 7.500。真实的分界来自字幕句末,基本不会这么巧。）
 */
export function pickCutPoint (
  keyframeSec: readonly number[], boundaryMs: number, fps: number = FPS,
): number | null {
  if (!Number.isFinite(boundaryMs) || boundaryMs <= 0) return null
  // 容忍半帧：分界正好压在关键帧上时，浮点抖动不该让我们跳到下一个关键帧
  const target = boundaryMs / 1000 - 0.5 / fps
  const hit = keyframeSec.find((t) => Number.isFinite(t) && t >= target)
  if (hit === undefined) return null
  /*
   * ⚠️【必须就在分界那一帧上】。我们烧的时候在分界处强制过一帧,所以正常
   * 情况下 hit 和分界最多差不到一帧。差得多说明【那一帧不在】——找到的是
   * 别的地方一个碰巧的关键帧。照它切,接缝就跑到了别处:头段会比挑的开头
   * 素材还长,而后半段从一个谁也没打算切的地方开始。
   * 这种时候老老实实整条重烧。
   */
  if (hit - boundaryMs / 1000 >= 1 / fps) return null
  return hit
}

async function cutPointSec (masterPath: string, boundaryMs: number): Promise<number | null> {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-show_packets',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', masterPath,
    ], { maxBuffer: 64 << 20 })
    const keys = stdout.split('\n')
      .filter((l) => l.includes('K'))
      .map((l) => Number(l.split(',')[0]))
    return pickCutPoint(keys, boundaryMs)
  } catch {
    return null
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
    const wholeFrames = await countPackets(masterPath)

    /*
     * 【先问清楚这一刀到底该落在哪一毫秒】。不是分界本身——见 cutPointSec。
     * 问不出来(那条母带压根没有这一帧)就退回整条重烧。
     */
    const cutSec = await cutPointSec(masterPath, plan.boundaryMs)
    if (cutSec === null) {
      await cleanup()
      return false
    }
    /*
     * 头段的帧数 = 切点之前的帧数。后面所有的校验都拿它当标尺。
     * 切点是某一帧的 pts,所以乘回帧率再取整就是那一帧的序号。
     */
    const headFrames = Math.round(cutSec * FPS)
    if (headFrames <= 0 || headFrames >= wholeFrames) {
      await cleanup()
      return false
    }

    /*
     * ── ① 切后半段 ────────────────────────────────────────────────
     * `-ss` 在 `-i` 【前面】:输入端定位,直接在容器里跳过去。
     * 放后面是输出选项,会从头解码到切点——母带是 458MB。
     */
    await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', cutSec.toFixed(6),
      '-i', masterPath,
      '-c', 'copy',
      tailPath,
    ])
    /*
     * ⚠️【切完必须验第一个包是关键帧】。不验的话,一条没有那一帧的母带
     * 也能"切成功"——ffmpeg 不报错,只是把整条搬了过来。
     */
    if (!await firstPacketIsKeyframe(tailPath)) {
      await cleanup()
      return false
    }
    /*
     * ⚠️【验帧数,不能验时长】。切歪的时候 ffmpeg 会把整条搬过来,再用
     * edit list 把起点标到切点——**容器时长因此仍然是"整条 − 分界"**,
     * 拿时长去验等于没验。实测就是这么放过去一条 779 帧的片子(应该 600),
     * 而 ffprobe 报的时长只差 1 毫秒。
     * 帧数不会骗人:搬了多少就是多少。
     */
    if (await countPackets(tailPath) !== wholeFrames - headFrames) {
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
       * ⚠️【正好烧 headFrames 帧,一帧不多一帧不少】。字幕的时间轴是从 0 起的
       * 整条,烧到这儿就停,画面和字幕自然都只剩开头那一段。
       * 多一帧的话后半段整体后移 33 毫秒,字幕从接缝一直错到片尾;
       * 少一帧则拼出来短一帧。用帧数而不是时间,见 types.ts 的 frames。
       */
      durationMs: Math.round(cutSec * 1000),
      frames: headFrames,
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
     * ⚠️【拼完再数一次帧】。concat 对参数不一致【不一定报错】,可能产出
     * 一个只有前半段能正常播的文件;而上面那类切歪的故障更阴——时长完全正常,
     * 只是多了一整段旧开头。**帧数是唯一不会骗人的那个数**,一帧都不能差。
     */
    if (await countPackets(joined).catch(() => -1) !== wholeFrames) {
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
