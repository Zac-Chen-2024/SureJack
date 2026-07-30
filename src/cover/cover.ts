import { execFile } from 'node:child_process'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { AspectPreset } from '../types.js'

/**
 * 封面：在成片最前面插两帧「封面图 + 标题」。
 *
 * ── 为什么是两帧 ────────────────────────────────────────────────────
 * 平台抓缩略图默认取第一帧。塞两帧封面进去，列表页展示的就是我们设计过的
 * 封面，而不是正片随机的第一帧；两帧 @30fps 只有 0.067 秒，观众几乎察觉
 * 不到，正片内容一帧不少。
 *
 * ── 版式是量出来的，不是调出来的 ────────────────────────────────────
 * 下面这几个比例来自对参考图逐像素的拟合（spikes/cover/ 四个脚本）：
 * 先用两层掩膜（黑描边的外轮廓 + 白字心）在七个字重里认出字体，
 * 再在原尺度上解字号、描边、位置。最终外轮廓 IoU 0.961、字心 IoU 0.941，
 * 剩下的差异只有边缘一个像素的抗锯齿。
 *
 *   字体    思源黑体 Medium（SourceHanSansCN-Medium）
 *   字号    0.16508 × 画布宽    （1260 宽 → 208 px）
 *   描边    0.03846 × 字号      （→ 8 px），纯黑
 *   位置    水平居中；垂直居中再下移 0.0096 × 字号（→ +2 px）
 *
 * ⚠️【字重必须是 Medium】。同族的 Regular / Bold 看着差不多，逐字比对
 * 却是 0.82 / 0.85，而 Medium 是 0.91——曲线是干净的单峰。加粗描边能把
 * 瘦字撑成胖字的外形，所以只看外轮廓认不出字重，必须连字心一起比。
 *
 * ── 为什么用 drawtext 而不是 libass ─────────────────────────────────
 * 字幕那条路走的是 ASS + libass，但 libass 的 Fontsize 不是像素级的 em
 * 尺寸（实测同样填 207，字比 freetype 小了 1.43 倍），要对齐得先反解它的
 * 缩放系数。drawtext 直接吃 freetype，fontsize 就是像素，实测水平方向
 * 一个像素不差。封面是静止一张图、没有卡拉OK着色，用不上 libass 的长处。
 */

/** 一律 30fps；两帧 = 2/30 秒 */
const FPS = 30
export const COVER_FRAMES = 2

const SIZE_RATIO = 0.16508      // 字号 / 画布宽
const STROKE_RATIO = 0.03846    // 描边 / 字号
const BASELINE_RATIO = 0.0096   // 垂直微调 / 字号

/** 固定封面图和封面字体都跟着代码走，部署即到位 */
export const COVER_IMAGE = join(process.cwd(), 'assets/cover/default.jpg')
export const COVER_FONT = join(process.cwd(), 'assets/fonts/SourceHanSansCN-Medium.otf')

/** 封面片段的文件名（放在项目目录里，和成片同级） */
export const COVER_CLIP_FILE = 'cover.mp4'

/**
 * drawtext 的 text 值要转义。
 *
 * 【冒号和反斜杠是滤镜图的语法字符】：标题里出现一个冒号，整条
 * -vf 就会被切错，ffmpeg 报的还是"看不懂的选项"这种毫无指向的错。
 * 单引号同理——它是 ffmpeg 自己那层引号。
 */
export function escapeDrawtext (text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
}

/** 标题：项目自己填的优先，没填就用项目名 */
export function coverTitleOf (project: { name: string; coverTitle?: string | null }): string {
  const t = (project.coverTitle ?? '').trim()
  return t === '' ? project.name : t
}

export function coverDrawtextFilter (title: string, aspect: AspectPreset): string {
  const size = Math.round(aspect.width * SIZE_RATIO)
  const border = Math.max(1, Math.round(size * STROKE_RATIO))
  const dy = Math.round(size * BASELINE_RATIO)
  return [
    `scale=${aspect.width}:${aspect.height}:force_original_aspect_ratio=increase`,
    `crop=${aspect.width}:${aspect.height}`,
    [
      `drawtext=fontfile=${COVER_FONT}`,
      `text='${escapeDrawtext(title)}'`,
      `fontsize=${size}`,
      'fontcolor=white',
      `borderw=${border}`,
      'bordercolor=black',
      'x=(w-text_w)/2',
      `y=(h-text_h)/2+${dy}`,
    ].join(':'),
    `fps=${FPS}`,
    'setsar=1',
  ].join(',')
}

/**
 * 渲染封面片段（两帧，带同样长度的静音轨）。
 *
 * ⚠️【编码参数必须和母带逐项一致】。下一步的拼接走的是 concat demuxer
 * + `-c copy`，它要求两段的编码器参数、SPS/PPS 完全对得上；差一项就是
 * "拼出来花屏"或者直接报错。所以这里的 libx264/preset/crf/pix_fmt/
 * 帧率/aac 码率都是从 render/ffmpeg.ts 抄来的，那边改了这边要跟着改。
 */
export interface AudioParams { sampleRate: number; channelLayout: string }

/**
 * 正片的音频参数。**必须照抄，不能写死**。
 *
 * 踩过：封面按 44100/stereo 生成，而 Azure 配音出来的成片是 24000/mono，
 * concat 的 `-c copy` 遇到参数不一致的两段音频，轻则拼完后半段没声音，
 * 重则直接报错。自备配音那条路又可能是 44100/stereo——所以只能现问。
 */
export async function probeAudio (filmPath: string): Promise<AudioParams> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channel_layout',
      '-of', 'default=nw=1:nk=1', filmPath,
    ], (err, stdout, stderr) => {
      if (err) reject(new Error(`探测音频参数失败：${stderr || err.message}`))
      else resolve(stdout)
    })
  })
  const [rate, layout] = out.trim().split('\n')
  return {
    sampleRate: Number(rate) || 44100,
    channelLayout: (layout ?? '').trim() || 'stereo',
  }
}

export function coverClipArgs (opts: {
  imagePath: string; title: string; aspect: AspectPreset; outPath: string
  audio: AudioParams
}): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', opts.imagePath,
    // 静音轨：没有音频流的话 concat 会因为流数量对不上而失败。
    // 参数照抄正片，见 probeAudio 上面那段注释
    '-f', 'lavfi', '-i',
    `anullsrc=channel_layout=${opts.audio.channelLayout}:sample_rate=${opts.audio.sampleRate}`,
    '-vf', coverDrawtextFilter(opts.title, opts.aspect),
    '-frames:v', String(COVER_FRAMES),
    '-t', (COVER_FRAMES / FPS).toFixed(4),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    opts.outPath,
  ]
}

function run (args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${what}失败：${stderr || err.message}`))
      else resolve()
    })
  })
}

export async function renderCoverClip (opts: {
  imagePath: string; title: string; aspect: AspectPreset; outPath: string
  audio: AudioParams
}): Promise<void> {
  await run(coverClipArgs(opts), '封面渲染')
}

/**
 * 把封面片段拼到成片前面。
 *
 * `-c copy` 只搬压缩帧，十几分钟的片子也就一两秒——**绝不能在这里
 * 重编码**，那等于把烧录的代价又付一遍。
 *
 * 同样【先写临时文件再 rename】：拼接期间那个文件是半截的，而它正是
 * 用户此刻可能在播放/下载的那一份。
 */
export async function prependCover (opts: {
  coverPath: string; filmPath: string; outPath: string
}): Promise<void> {
  const partial = `${opts.outPath}.partial.mp4`
  const listPath = join(dirname(opts.outPath), 'cover-concat.txt')
  // concat demuxer 的清单里，单引号要写成 '\''
  const q = (p: string): string => `file '${p.replace(/'/g, "'\\''")}'`
  await writeFile(listPath, `${q(opts.coverPath)}\n${q(opts.filmPath)}\n`, 'utf-8')
  try {
    await run([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      partial,
    ], '封面拼接')
    await rename(partial, opts.outPath)
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {})
    throw e
  } finally {
    await rm(listPath, { force: true }).catch(() => {})
  }
}
