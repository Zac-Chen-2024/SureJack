import { splitSentences, cutAfter, type Sentence } from './sentences.js'
import { inVideoTitleOf } from '../subtitles/project-ass.js'

/**
 * 把一条长文拆成【主片正文】和【续集正文】。纯函数，不碰数据库。
 *
 * 续集 = 引子 + 提醒语 + 从断点接着讲的正文。三段一起走一次配音，
 * 所以提醒语有声音也有字幕——它是说给观众听的，不是一块贴图。
 *
 * ⚠️【接缝处一个字都不能改】。主片的尾巴和续集正文的头必须严丝合缝地
 * 拼回原文：中间掉一句，观众听到的就是"说了半句跳到下一段"，而这种缺失
 * 在预览里极难发现——两边各自都是通顺的。所以这里只做下标切片。
 */

/**
 * 提醒语模板。`{title}` 填【主片的片内标题】——那是观众在第一集屏幕上
 * 一直看着的那行字，用它来称呼"上一集"才对得上号；用项目名的话，
 * 观众根本没见过那个名字。
 */
export const REMINDER_TEMPLATE = '周周提醒你，{title}第二集开始啦。'

export function buildReminder (mainInVideoTitle: string): string {
  return REMINDER_TEMPLATE.replace('{title}', mainInVideoTitle)
}

export interface SplitResult {
  /** 主片正文：开头到断点句（含） */
  mainText: string
  /** 续集正文：引子 + 提醒语 + 断点之后 */
  sequelText: string
  /** 拆完各自的估算时长，给界面显示 */
  mainEstimatedMs: number
  sequelEstimatedMs: number
}

export function splitStory (opts: {
  text: string
  /** 切在这一句【之后】 */
  breakIndex: number
  /** 引子到这一句【结束】为止 */
  introEndIndex: number
  /** 主片的片内标题，用来生成提醒语 */
  mainInVideoTitle: string
  sentences?: Sentence[]
}): SplitResult {
  const sentences = opts.sentences ?? splitSentences(opts.text)
  if (sentences.length === 0) throw new Error('正文是空的，拆不了')

  const last = sentences.length - 1
  const breakIndex = Math.min(last, Math.max(0, opts.breakIndex))
  /*
   * 【引子不能越过断点】。越过的话续集会把主片还没讲到的内容先剧透一遍，
   * 而且提醒语之后的正文和引子会重叠。夹住它，最多到断点前一句。
   */
  const introEnd = Math.min(Math.max(0, opts.introEndIndex), Math.max(0, breakIndex - 1))

  const { head: mainText, tail } = cutAfter(opts.text, sentences, breakIndex)
  const intro = opts.text.slice(0, sentences[introEnd]!.end)
  const reminder = buildReminder(opts.mainInVideoTitle)

  /*
   * 三段之间用换行分开。**不要用空格**——配音的断句和字幕的分行都看标点，
   * 空格既不产生停顿也不换行，提醒语会和引子的最后一句黏成一句读出来。
   */
  const sequelText = `${intro.trim()}\n${reminder}\n${tail.trim()}`

  const est = (t: string): number => {
    const ss = splitSentences(t)
    return ss.length === 0 ? 0 : ss[ss.length - 1]!.cumulativeMs
  }
  return {
    mainText,
    sequelText,
    mainEstimatedMs: sentences[breakIndex]!.cumulativeMs,
    sequelEstimatedMs: est(sequelText),
  }
}

/**
 * 续集的三个标题。
 *
 * ⚠️【只有封面标题带“2”，片内标题不带】。
 *
 * 封面是给刷到的人看的：他没看过第一集，「…2」才告诉他这是续集、
 * 前面还有一集可看，这个「2」是有用信息。
 * 片内标题是全片顶部常驻的那行，它的作用是"这个故事叫什么"——两集是
 * 同一个故事，标题就该是同一个。挂个「2」在那儿反而像是剧名的一部分。
 *
 * 项目名带「2」是另一回事：那是作者自己在列表里认片子用的，观众看不到。
 *
 * 这个函数只在【创建那一刻】和【点"用项目名做标题"那一下】用；
 * 之后用户改了哪个都不会被覆盖回去。
 */
export function sequelTitles (main: { name: string; inVideoTitle?: string | null }): {
  name: string; coverTitle: string; inVideoTitle: string
} {
  const base = inVideoTitleOf(main)
  return {
    name: `${main.name}2`,
    coverTitle: `${base}2`,
    inVideoTitle: base,
  }
}
