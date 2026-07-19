import { spawn } from 'node:child_process'
import { FONTS_DIR } from '../config.js'
import { buildFitFilter, buildAudioFilter } from './filters.js'
import type { RenderJob } from '../types.js'

/**
 * 解析 ffmpeg -progress 的输出，返回 0..100 的百分比。
 * 拿不到进度信息时返回 null。
 */
export function parseProgress (chunk: string, totalMs: number): number | null {
  const m = /out_time_ms=(\d+)/.exec(chunk)
  if (!m) return null
  const doneMs = Number(m[1]) / 1000   // out_time_ms 实际单位是微秒
  return Math.min(100, Math.max(0, (doneMs / totalMs) * 100))
}

/**
 * 创建一个行缓冲解析器。
 *
 * stdout 的 data 事件不保证按行切分，可能在中间切断数字。例如若
 * `out_time_ms=92100000\n` 被拆成 `out_time_ms=921` 和 `00000\n` 两个 chunk，
 * 直接喂给 parseProgress 会得到 0.0005% 的错误百分比，导致进度条倒退。
 * 本函数负责缓冲不完整行，确保只向回调传递完整行。
 */
export function createProgressParser (
  totalMs: number,
  onProgress: (pct: number) => void
): (chunk: string) => void {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    // 最后一段可能不完整，留到下次 chunk 再拼接
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const pct = parseProgress(line, totalMs)
      if (pct !== null) onProgress(pct)
    }
  }
}

/**
 * 构造 ffmpeg 参数。
 *
 * 输入顺序（滤镜里靠这个索引）：0=背景视频，1=配音，2=BGM（若有）。
 *
 * ⚠️ 本函数只处理【单片段】的快路径——用 -stream_loop -1 直接循环输入。
 * 多片段需要两趟渲染（ffmpeg 的 loop 滤镜按帧工作、吃内存，而 -stream_loop
 * 只能作用于输入文件，没法作用于 concat 的结果）。多片段留到阶段 3 前实现，
 * 届时先把片段拼接成中间文件，再走这条同样的路径。
 */
export function buildArgs (job: RenderJob): string[] {
  const clip = job.clips[0]
  if (!clip) throw new Error('至少需要一个背景视频片段')
  if (job.clips.length > 1) {
    throw new Error('多片段拼接尚未实现——需要两趟渲染，见 render/ffmpeg.ts 的说明')
  }

  const durationSec = (job.durationMs / 1000).toFixed(1)
  const hasBgm = Boolean(job.bgmPath)

  const filters = [
    buildFitFilter(clip, job.aspect, '0:v', 'fit'),
    `[fit]ass=${job.assPath}:fontsdir=${FONTS_DIR}[v]`,
    buildAudioFilter(hasBgm, job.bgmVolume),
  ].join(';')

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-progress', 'pipe:1',
    '-stream_loop', '-1', '-i', clip.path,
    '-i', job.voicePath,
    /*
     * BGM 也要 -stream_loop -1 循环。
     *
     * 素材库里 9 首 BGM 是 7.6–11.6 分钟，而营销号长文案能到 13 分钟以上。
     * 不循环的话，BGM 放完就静音——用最短的那首会有 5 分多钟全程没有音乐，
     * 而成片时长看着完全正常（静音也算时长），只有真听才发现。
     *
     * 【必须紧挨着 BGM 的 -i】：-stream_loop 是输入选项，只作用于它后面
     * 那一个 -i。放到别处会去循环配音或背景视频。
     *
     * 用 -stream_loop 而不是 aloop 滤镜：后者按帧工作、把整段音频读进内存，
     * 在 100MB 的 wav 上代价明显。
     *
     * 收尾靠 buildAudioFilter 里的 amix duration=first —— 混音在配音结束时截断，
     * 所以无限循环的 BGM 不会让成片变长。
     */
    ...(hasBgm ? ['-stream_loop', '-1', '-i', job.bgmPath!] : []),
    '-filter_complex', filters,
    '-map', '[v]', '-map', '[aout]',
    '-t', durationSec,
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-pix_fmt', 'yuv420p',        // 不加这条，成片在部分播放器和平台上直接不能播
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    job.outPath,
  ]
}

/** 跑 ffmpeg。失败时把 stderr 完整带出来——否则排查等于瞎猜。 */
export function render (job: RenderJob, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', buildArgs(job))
    let stderr = ''
    const parser = onProgress ? createProgressParser(job.durationMs, onProgress) : null

    proc.stdout.on('data', (d: Buffer) => {
      if (parser) parser(d.toString())
    })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) { onProgress?.(100); resolve() }
      else reject(new Error(`ffmpeg 退出码 ${code}：\n${stderr.slice(-2000)}`))
    })
  })
}
