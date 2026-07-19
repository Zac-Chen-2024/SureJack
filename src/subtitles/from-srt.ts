import { parseSrt } from './srt.js'
import type { WordTiming } from '../types.js'

/** 自备 SRT 解析结果，可直接落进项目的 wordTimingsJson */
export interface SrtAdoption {
  /** 展平后的时间轴：**每条 cue 一项**，整句话就是那一"词" */
  words: WordTiming[]
  /** 解析到的 cue 条数。0 表示文件不是标准 SRT，调用方要报错 */
  cueCount: number
  /** 最后一条 cue 的结束时间，用来跟配音时长比对 */
  lastEndMs: number
}

/**
 * 自备 SRT 文本 → 项目的词级时间轴（其实是**句级**）。
 *
 * ⚠️ 这里【只做展平，不做任何再加工】：
 *
 * - **绝不能跑 `segmentLines`**。那是给 Azure 的词级时间轴断句用的；
 *   SRT 已经是用户/剪辑软件断好的分行，再断一次会把两条很短的相邻 cue
 *   攒进同一行（'甲' + '乙' 才 2 个字，远不到 14 字上限），显示时间从
 *   第一条的起点一路盖到第二条的终点，中间那段静音也顶着字幕。
 *   `srt.ts` 的注释里写了同一条禁令。
 * - **不拆标点**。拆了 segmentLines 的标点断行逻辑就会重新有机可乘。
 * - **不碰时间数字**。parseSrt 从 `HH:MM:SS,mmm` 逐段 parseInt 算出来的
 *   就是整数毫秒，这里做任何缩放/换算都可能引入小数——踩过：小数毫秒
 *   让背景排布直接 500。
 *
 * 由此产生的能力边界：**自备 SRT 做不了逐字卡拉OK**。SRT 格式本身就没有
 * 字级时间。所以采用这条路的项目要配 `subtitleMode: 'line'`（整句显示），
 * 这一点必须在界面上告诉用户，否则他传完发现没扫光会以为坏了。
 */
export function adoptSrtText (text: string): SrtAdoption {
  const lines = parseSrt(text)
  // parseSrt 保证每条 SubtitleLine 的 words 恰好一项（整句），flatMap
  // 于是就是「一条 cue 一个 WordTiming」
  const words = lines.flatMap((l) => l.words)
  const last = lines[lines.length - 1]
  return {
    words,
    cueCount: lines.length,
    lastEndMs: last?.endMs ?? 0,
  }
}

/**
 * 把 SRT 的正文反解码成一段可编辑的文案。
 *
 * 文案是项目的一等公民（设计文档第一条）——自备配音+字幕的项目如果
 * 文案区是空的，这条视频在列表里就"没有内容"，看不出讲的是什么，也
 * 没法再编辑。所以采用 SRT 时顺手把正文还原回去。
 *
 * 拼接方式：
 * - **cue 之间用换行**。一条 cue 就是作者断的一句/一屏，一行一条读起来
 *   最接近原稿，也方便用户对着字幕逐条改。
 * - **cue 内部的换行抹平成无分隔**。SRT 里的行内换行是**显示用的断行**
 *   （屏幕放不下才折），不是语义换行；中文词间没有空格，直接拼接才是
 *   原句。保留它反而会把一句话在文案区拆成两段。
 *
 * ⚠️ 因果方向和 AI 配音路径【相反】：AI 路径是文案 → 配音 → 字幕，
 * 自备路径是 SRT → 文案。所以改了这里填出来的文案**不会**让字幕跟着变
 * （字幕来自上传的 SRT）。界面上必须说清楚。
 */
export function scriptFromSrtWords (words: WordTiming[]): string {
  return words.map((w) => w.text.replace(/\s*\n\s*/g, '')).join('\n')
}

/**
 * 字幕比配音长多少才值得警告。
 *
 * **只警告不阻断**：尾部留白是正常的（作者故意让最后一句停久一点），
 * 但差出一大截通常意味着配音和字幕不是一对。1 秒以内属于噪声。
 */
export const SRT_OVERRUN_TOLERANCE_MS = 1000

/** 字幕明显超出配音时长时的提示文案，没超出返回 null */
export function overrunWarning (lastEndMs: number, voiceDurationMs: number): string | null {
  const over = lastEndMs - voiceDurationMs
  if (over <= SRT_OVERRUN_TOLERANCE_MS) return null
  return `字幕比配音长 ${(over / 1000).toFixed(1)} 秒，超出的部分不会出现在成片里。`
    + '如果两个文件本来就不是一对，请重新上传。'
}
