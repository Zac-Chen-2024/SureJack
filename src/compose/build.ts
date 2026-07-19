/**
 * 把三段式排布变成一条真实的视频文件。
 *
 * `planBackground()` 只算「用哪些片、从哪一秒起、各取多久」——纯函数、不碰 IO。
 * 这里是它的另一半：调 ffmpeg 把每一段截出来、归一化、再 concat 成一条与配音
 * 等长的无声背景轨，交给现有的烧录管线当作单个背景视频用。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSource, normalizedPath, TARGET } from '../library/normalize.js'
import type { AspectPreset } from '../types.js'

/** 一段：从素材库某个桶的某个文件里，从 startMs 起截 takeMs 毫秒。 */
export interface BuildSegment {
  bucket: string
  filename: string
  startMs: number
  takeMs: number
}

export interface BuildBackgroundOptions {
  segments: readonly BuildSegment[]
  /** 素材库所在的 data 根目录（全局公用，不经过 userDbDir） */
  dataDir: string
  aspect: AspectPreset
  outPath: string
  /** 中间片段落在这个目录下的临时子目录里。默认系统临时目录。 */
  workRoot?: string
  onProgress?: (pct: number) => void
}

/** 背景轨的帧率。与最终烧录的 -r 30 保持一致，避免二次变速。 */
const FPS = 30

/** 毫秒 → ffmpeg 认的秒字符串（毫秒精度，别丢） */
function sec (ms: number): string {
  return (ms / 1000).toFixed(3)
}

/**
 * 重编码一段时实际要取多长。
 *
 * 【重编码路径同样会短】。`-t` 截在最后一个 PTS 小于它的帧上，所以每段
 * 都会丢掉不足一帧的零头——单段最多 1/30 秒，看着可以忽略，但排布是
 * 十几段，加起来就成了实打实的缺口。实测一条 4.000 秒的排布（三段）
 * 只拼出 3.968 秒。
 *
 * 缺口的后果和拷贝路径一模一样：烧录那步对背景加了 `-stream_loop -1`，
 * 轨比配音短就会从头循环，接缝处画面突然跳回开头。
 *
 * 补一帧就够——不足一帧的零头，补一个整帧必然盖住。比拷贝路径的
 * 一个关键帧间隔（1 秒）省得多，而重编码的每一帧都是要花 CPU 的。
 */
export function encodeTakeMs (takeMs: number): number {
  return takeMs + Math.ceil(1000 / FPS)
}

/**
 * 单段的 ffmpeg 参数。
 *
 * ⚠️【`-ss` 必须排在 `-i` 前面】。放在 `-i` 后面是输出选项，ffmpeg 会从文件头
 * 一路解码到截取点再开始写——地铁跑酷桶里的源文件到 1GB，那是几十秒的差距，
 * 而一条成片要截好几段。放在 `-i` 前面是输入选项，直接在容器里跳过去。
 *
 * ⚠️【分辨率/帧率/SAR 必须先统一】。下一步的 concat demuxer 是流级拼接，
 * 要求所有输入的这些参数完全一致；而素材库里的片子来源杂乱（竖屏切片、
 * 横屏录屏都有）。scale+crop 填满目标画幅，fps 钉死帧率，setsar=1 钉死
 * 像素宽高比——少任何一样，concat 都可能拼出花屏或者直接报错。
 *
 * ⚠️【一律 `-an`】。背景静音是设计约束：成片的声音只有配音 + BGM。
 * 素材里带着的原声不能漏出来。
 */
export function segmentArgs (
  srcPath: string, seg: BuildSegment, aspect: AspectPreset, outPath: string,
): string[] {
  const { width: W, height: H } = aspect
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    `fps=${FPS}`,
    'setsar=1',
  ].join(',')

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', sec(seg.startMs),      // 【在 -i 之前】——输入端快速定位
    '-i', srcPath,
    '-t', sec(encodeTakeMs(seg.takeMs)),   // 补一帧，宁长勿短（见 encodeTakeMs）
    '-an',                        // 背景一律静音
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    outPath,
  ]
}

/**
 * 归一化时设的关键帧间隔（毫秒）。normalize.ts 用的是 `-g 30` @ 30fps，
 * 也就是每秒一个关键帧——`-c copy` 的切点只能落在这些位置上。
 */
export const KEYFRAME_MS = 1000

/**
 * 拷贝一段时实际要取多长。
 *
 * 【永远比请求的长】。`-c copy` 搬的是压缩帧，末尾会截到最后一个完整帧，
 * 请求 1.000s 实测可能只给 0.967s；起点又吸附到前一个关键帧。这些误差
 * 单看无所谓——背景是填充画面，段边界差 0.1 秒没人看得出，总长还有烧录
 * 那步的 `-t` 精确截断。
 *
 * 但【短了就有事】：`buildArgs` 给背景加了 `-stream_loop -1`，轨比配音短
 * 就会从头循环，接缝处画面突然跳回开头，非常显眼。所以一律向上取整到
 * 关键帧网格【再多给一格】——多出来的部分被烧录截掉，是免费的。
 */
export function copyTakeMs (takeMs: number): number {
  return Math.ceil(takeMs / KEYFRAME_MS) * KEYFRAME_MS + KEYFRAME_MS
}

/**
 * 这一段能不能直接拷贝。
 *
 * 两个条件缺一不可：
 *
 * 1. **取到的确实是归一化产物**。`resolveSource` 在没转过时会退回原文件，
 *    而原素材规格杂乱（720x1280 / 1844x4096 都有），拷贝拼不起来——
 *    concat demuxer 是流级拼接，要求所有输入参数完全一致。归一化【正在
 *    后台跑】，所以"转了一半"是常态，必须逐段判断。
 *
 * 2. **目标画幅就是归一化的目标规格**。归一化产物固定 1080x1920；导出到
 *    别的画幅时若照样拷贝，就会把 1080x1920 的段和现编码出来的段拼到
 *    一起。⚠️ concat 对这种不一致【不一定报错】，可能产出一个只有第一段
 *    能正常播的文件——时长还是对的，肉眼看进度条完全正常。
 */
export function canCopySegment (
  srcPath: string, normPath: string, aspect: AspectPreset,
): boolean {
  return srcPath === normPath
    && aspect.width === TARGET.width
    && aspect.height === TARGET.height
}

/**
 * 拷贝路径的单段参数。
 *
 * 没有 `-vf`、没有 `-c:v`——有任何一个都等于解码重编码，这条路径快 175 倍
 * 的全部原因就是它什么都不做，只把压缩帧从一个容器搬到另一个容器。
 *
 * `-ss` 仍在 `-i` 之前（输入端定位），`-an` 仍然保留：背景静音是设计约束，
 * 换条路径也不放松。
 */
export function copySegmentArgs (
  srcPath: string, seg: BuildSegment, outPath: string,
): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', sec(seg.startMs),
    '-i', srcPath,
    '-t', sec(copyTakeMs(seg.takeMs)),
    '-an',
    '-c', 'copy',
    outPath,
  ]
}

/**
 * concat demuxer 的清单内容。
 *
 * 路径用单引号包起来——素材包里有 `6月1日(8.mp4` 这种残缺文件名，括号、
 * 空格都得原样活下来。清单里的单引号按 ffmpeg 的规矩转义成 `'\''`。
 */
export function concatListContent (paths: readonly string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join('')
}

/** 跑一次 ffmpeg。失败时把 stderr 带出来——否则排查等于瞎猜。 */
function ffmpeg (args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：\n${stderr.slice(-2000)}`))
    })
  })
}

/**
 * 按排布生成一条背景轨，返回 outPath。
 *
 * 进度：每归一化完一段报一次，concat 完成报 100。**不能不报**——13 分钟的
 * 成片要截十几段，全程几分钟，导出进度条卡在 0 会被当成卡死。
 *
 * 中间片段一律落在临时子目录，**无论成败都清理**：一条 13 分钟的背景轨，
 * 中间片段加起来能有好几百 MB，失败时留下来几次就把磁盘吃满了。
 */
export async function buildBackgroundTrack (opts: BuildBackgroundOptions): Promise<string> {
  const { segments, dataDir, aspect, outPath, onProgress } = opts
  if (segments.length === 0) {
    throw new Error('排布是空的，无法生成背景轨——先确认配音已就绪且素材库已扫描')
  }

  const root = opts.workRoot ?? tmpdir()
  const work = await mkdtemp(join(root, 'bgtrack-'))
  try {
    const parts: string[] = []
    for (const [i, seg] of segments.entries()) {
      /*
       * 【桶名先过白名单】：normalizedPath / resolveSource 内部都是 isBucket，
       * 素材库不经过 userDbDir()，这是唯一一道防路径穿越的闸。
       *
       * 转过的用转好的，没转过的退回原文件——归一化【随时可以中断】，
       * "只转完一部分"是常态，所以这个判断必须逐段做。
       */
      const norm = normalizedPath(dataDir, seg.bucket, seg.filename)
      const src = await resolveSource(dataDir, seg.bucket, seg.filename)
      const part = join(work, `part-${String(i).padStart(4, '0')}.mp4`)
      await ffmpeg(canCopySegment(src, norm, aspect)
        ? copySegmentArgs(src, seg, part)
        : segmentArgs(src, seg, aspect, part))
      parts.push(part)
      // 留一格给 concat：全部截完只到 (n)/(n+1)
      onProgress?.(((i + 1) / (segments.length + 1)) * 100)
    }

    const listPath = join(work, 'list.txt')
    await writeFile(listPath, concatListContent(parts), 'utf-8')

    /*
     * concat demuxer + `-c copy`：上面已经把每段编码成同样的参数了，
     * 这里只是把流首尾相接，不重新编码——比 concat 滤镜快一个数量级。
     * `-safe 0` 是因为清单里是绝对路径。
     */
    await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      outPath,
    ])
    onProgress?.(100)
    return outPath
  } finally {
    // 【无论成败】——失败留下的半成品同样占几百 MB
    await rm(work, { recursive: true, force: true })
  }
}
