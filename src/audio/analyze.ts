import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TARGET_LUFS } from '../compose/mix.js'

const run = promisify(execFile)

/**
 * 一条音轨的"体检报告"：波形 + 响度。
 *
 * ── 为什么在服务端算 ────────────────────────────────────────────────
 * 一条 10 分钟的配音解码出来是几十兆 PCM。让手机浏览器现解码、现算峰值，
 * 界面会卡住好几秒——而这一屏正是用户要来回拖滑块的地方。
 * 所以【配音一完成、音乐一选中就先算好存下来】，用户点进来时数据已经在了。
 *
 * ── 为什么峰值只取 600 个点 ─────────────────────────────────────────
 * 手机上那条波形也就三四百个物理像素宽，600 个点已经比屏幕还密。
 * 存全量既没用又让接口变肥。
 */

/** 波形取样点数。比手机屏幕的物理像素还密，再多纯属浪费 */
export const WAVE_POINTS = 600

export interface AudioStats {
  /** 整体响度（LUFS）。越接近 0 越响；-14 是流媒体常用基准 */
  lufs: number
  /** 真峰值（dBTP）。超过 0 就会削顶失真 */
  truePeak: number
  /** 波形包络，0–1，长度 WAVE_POINTS */
  peaks: number[]
  durationMs: number
}

/** 从 ebur128 的输出里捞最后一次汇总（它每隔一段就打一次，最后那次才是全曲） */
function parseLoudness (stderr: string): { lufs: number, truePeak: number } {
  const i = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].pop()
  const p = [...stderr.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].pop()
  return {
    lufs: i ? Number(i[1]) : Number.NEGATIVE_INFINITY,
    truePeak: p ? Number(p[1]) : Number.NEGATIVE_INFINITY,
  }
}

/**
 * 量一条音轨。
 *
 * ⚠️【一次 ffmpeg 同时拿波形和响度】。分两次跑要解码两遍，10 分钟的音频
 * 每遍好几秒。这里让 ebur128 和 PCM 输出共用同一次解码。
 */
export async function analyzeAudio (path: string): Promise<AudioStats> {
  // 8000Hz 单声道足够画包络，数据量只有原始的几十分之一
  const { stdout, stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', path,
    '-filter_complex', '[0:a]asplit=2[a][b];[a]ebur128=peak=true[e]',
    '-map', '[e]', '-f', 'null', '-',
    '-map', '[b]', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1',
  ], { maxBuffer: 1024 * 1024 * 512, encoding: 'buffer' as never }) as unknown as
    { stdout: Buffer, stderr: Buffer }

  const err = stderr.toString('utf8')
  const { lufs, truePeak } = parseLoudness(err)

  const pcm = stdout
  const total = Math.floor(pcm.length / 2)
  const peaks: number[] = []
  if (total > 0) {
    const per = Math.max(1, Math.floor(total / WAVE_POINTS))
    for (let i = 0; i < WAVE_POINTS; i++) {
      let max = 0
      const from = i * per
      const to = Math.min(total, from + per)
      for (let k = from; k < to; k++) {
        const v = Math.abs(pcm.readInt16LE(k * 2))
        if (v > max) max = v
      }
      peaks.push(Math.round((max / 32768) * 1000) / 1000)
    }
  }
  return { lufs, truePeak, peaks, durationMs: Math.round((total / 8000) * 1000) }
}

/**
 * 【音乐该压多低】。
 *
 * 行业惯例是人声之下 10 分贝左右——再响就压住人声，再轻就等于没有。
 * 这里按两条轨的实测响度反推增益：让音乐落在「配音 − 10 dB」。
 *
 * ⚠️ 返回的是【建议】，不是自动套用。用户拖过滑块之后就该以他为准——
 * 替他改掉他刚定好的东西，比不给建议更糟。
 */
export const MUSIC_BELOW_VOICE_DB = 10

export function recommendBgmVolume (voiceLufs: number, bgmLufs: number): number {
  if (!Number.isFinite(voiceLufs) || !Number.isFinite(bgmLufs)) return 0.15
  const wantDb = voiceLufs - MUSIC_BELOW_VOICE_DB      // 音乐目标响度
  const gainDb = wantDb - bgmLufs                       // 还差多少
  const gain = 10 ** (gainDb / 20)
  // 夹在合理区间：再小就听不见，再大就压住人声
  return Math.min(1, Math.max(0.02, Math.round(gain * 100) / 100))
}

/**
 * 【配音增益建议】：把配音本身推到接近平台基准。
 *
 * 归一化那一步已经会把成品对到 -14，所以这里给的是"让归一化少干活"的值——
 * 归一化提得越少，动态压缩带来的副作用越小。
 */
export function recommendVoiceGain (voiceLufs: number): number {
  if (!Number.isFinite(voiceLufs)) return 1
  const gain = 10 ** ((TARGET_LUFS - voiceLufs) / 20)
  return Math.min(4, Math.max(0.25, Math.round(gain * 100) / 100))
}
