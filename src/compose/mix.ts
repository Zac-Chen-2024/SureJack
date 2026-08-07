import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'

/**
 * 把【只有画面的母带】+ 配音 + 背景音乐 混成成片。
 *
 * ── 为什么配音也放在这一步 ──────────────────────────────────────────
 * 原来配音是和画面一起烧进母带的，于是"配音大一点"意味着重烧十几分钟的
 * 画面——等于不可调。现在画面归画面、声音归声音：两条音轨都在这里进来，
 * 任何一边的音量改一下只花几秒（视频流 -c:v copy，一帧都不重编码）。
 *
 * ── "声音小"的真正原因（实测）────────────────────────────────────────
 * 老路子把配音和 BGM 交给 amix，而 **amix 默认把每一路除以路数**：
 *     配音原始           -21.8 LUFS
 *     老混法（amix 默认） -27.7 LUFS   ← 白白低了 5.9 分贝
 *     amix normalize=0   -21.7 LUFS
 * 也就是【选了背景音乐的片子比没选的整整轻 6 分贝】，而没有任何提示。
 * 所以这里一律 normalize=0，各路的增益完全由我们自己给。
 *
 * ── 归一化 ──────────────────────────────────────────────────────────
 * 光修好 amix 还不够：-21.8 LUFS 本身就比短视频平台的惯用响度（约 -14）
 * 低了近 8 分贝。所以混完再走一道 EBU R128 归一化对到 TARGET_LUFS。
 * 两条滑块是在这个基准【之上】微调，而不是让用户自己把整体推响。
 */

/** 短视频平台的惯用响度。抖音/B站/YouTube 都在 -14 上下 */
export const TARGET_LUFS = -14
/** 真峰值上限。-1 dBTP 留一点余量，避免转码后削顶 */
export const TARGET_TP = -1
/** 响度范围。11 是语音+音乐这类内容的常见值 */
export const TARGET_LRA = 11

export interface MixOptions {
  /** 只有画面的母带 */
  masterPath: string
  voicePath: string
  /** 配音增益，1 = 原样。用户可调 */
  voiceGain: number
  /** 没选就不混音乐 */
  bgmPath: string | null
  /** 音乐增益，相对配音 */
  bgmVolume: number
  outPath: string
  /** 关掉归一化。只给测试用——归一化要跑两遍 ffmpeg，测试里没必要 */
  normalize?: boolean
}

/** 混音的滤镜图。单独拆出来是为了能直接测字符串，不用真跑 ffmpeg */
export function buildMixFilter (o: {
  voiceGain: number; bgmVolume: number; hasBgm: boolean; normalize: boolean
}): string {
  const parts: string[] = [`[1:a]volume=${o.voiceGain}[v]`]
  if (o.hasBgm) {
    parts.push(`[2:a]volume=${o.bgmVolume}[b]`)
    /*
     * ⚠️ normalize=0 是这一行的重点，不是可有可无的参数。
     * 默认的 normalize=1 会把每一路除以 2，配音凭空低 6 分贝。
     */
    parts.push('[v][b]amix=inputs=2:duration=first:normalize=0[m]')
  } else {
    parts.push('[v]anull[m]')
  }
  if (o.normalize) {
    parts.push(`[m]loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}[a]`)
  } else {
    parts.push('[m]anull[a]')
  }
  return parts.join(';')
}

export async function mixAudio (o: MixOptions): Promise<void> {
  /*
   * 【写临时文件再 rename】。直接写 outPath 的话，混音期间那个文件是
   * 半截的——而它正是用户此刻可能在播放/下载的那一份。线上真出过：
   * 拖了一下字幕高度触发重合，465MB 的成片当场变成 35MB 的残片。
   * rename 在同一文件系统上是原子的，旧文件在新的完全就绪之前一直有效。
   */
  const partial = `${o.outPath}.partial.mp4`
  const hasBgm = o.bgmPath !== null && o.bgmPath !== ''

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', o.masterPath,
    '-i', o.voicePath,
    // BGM 比配音短就循环铺满；-stream_loop 必须紧挨着它的 -i
    ...(hasBgm ? ['-stream_loop', '-1', '-i', o.bgmPath!] : []),
    '-filter_complex', buildMixFilter({
      voiceGain: o.voiceGain, bgmVolume: o.bgmVolume, hasBgm,
      normalize: o.normalize !== false,
    }),
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy',              // ⚠️ 这一句是整个优化的全部，别动
    '-c:a', 'aac', '-b:a', '192k',
    // 长度跟着母带走：BGM 无限循环也不会把成片拖长
    '-shortest',
    '-movflags', '+faststart',   // 让浏览器不用下完整个文件就能起播
    partial,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 32 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`混音失败：${stderr || err.message}`))
        else resolve()
      })
    })
    await rename(partial, o.outPath)
  } catch (e) {
    // 失败就把半成品收走，别留一个看起来像成片的残件
    await rm(partial, { force: true }).catch(() => {})
    throw e
  }
}
