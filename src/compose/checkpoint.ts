import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BG_TRACK_FILE } from './prebuild.js'
import { FILM_FILE, FILM_MASTER_FILE } from './film.js'

/**
 * 一条片子做到哪一步了。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 失败之后的重试，原来的说法是"回到项目里点『生成配音』重来一次"——
 * 那是把整条链从头再走：10 分钟配音 + 十几分钟烧录，而实际可能只是
 * 最后混一次音失败了。
 *
 * 盘上本来就有一串天然的 checkpoint，每一个都是上一步的完整产物：
 *
 *   voice.mp3     配音（连同词级时间戳落在库里）
 *   bg-track.mp4  背景轨（三段式排布拼出来的）
 *   master.mp4    母带（烧完字幕/标题/水印的）
 *   export.mp4    成片（混过 BGM、接了封面两帧）
 *
 * 重试要做的只是【找到最远的那个，从它的下一步接着走】。
 *
 * ⚠️【只看文件在不在，不判断它对不对】。"对不对"是指纹的活儿：
 * 每一步开工前都会拿指纹比对，对不上自然会重做。这里再判一遍等于把
 * 同一个规则写两遍，早晚会两边不一致。
 */
export type Checkpoint = 'none' | 'voice' | 'bg-track' | 'master' | 'export'

/** 给人看的名字，直接显示在"从这一步接着来"里 */
export const CHECKPOINT_LABEL: Record<Checkpoint, string> = {
  none: '从头开始',
  voice: '配音',
  'bg-track': '背景轨',
  master: '母带',
  export: '成片',
}

/** 下一步该做什么。给重试用：接着走的就是它 */
export const NEXT_STEP: Record<Checkpoint, string> = {
  none: '生成配音',
  voice: '拼背景轨',
  'bg-track': '烧录母带',
  master: '混音 + 接封面',
  export: '已经做完了',
}

export function checkpointOf (
  dir: string, opts: { ttsReady: boolean },
): Checkpoint {
  if (existsSync(join(dir, FILM_FILE))) return 'export'
  if (existsSync(join(dir, FILM_MASTER_FILE))) return 'master'
  if (existsSync(join(dir, BG_TRACK_FILE))) return 'bg-track'
  /*
   * 配音这一步【必须同时看文件和库里的状态】。半路被杀的合成会留下一个
   * 长度不对的 voice.mp3（实测：该有 441 秒，只写了 26 秒），文件在、
   * 但词级时间戳没落库——那不算做完。ttsState 是那一步真正的完成标记。
   */
  if (opts.ttsReady) return 'voice'
  return 'none'
}
