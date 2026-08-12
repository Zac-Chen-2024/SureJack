/**
 * 分集专用的每字毫秒。
 *
 * ⚠️【不能复用 tts/azure.ts 的 MS_PER_CHAR(196)】。那个数是给"切段绕开
 * Azure 10 分钟硬上限"用的，**故意往长了估**——估长了顶多多切一段，
 * 估短了会到 Azure 才失败。
 *
 * 分集这边完全相反：估算是拿给用户看的"这一集多长"，往长了估会让
 * "7–10 分钟"实际切出 4–6 分钟的片子（真机上就是这么翻车的：估 7.6 分钟，
 * 配出来 4.4 分钟）。所以这里用**实测值**。
 *
 * 实测（陈梓昂账号里 8 条已配音的项目，含标点和换行的字数）：
 *   军师 122.0 / 多疑 122.0 / 健身达人 108.8 / 周周撸铁 109.1、108.8、108.8
 *   分集验收 108.3 / 分集验收2 109.7
 * 绝大多数落在 108–110，取 110 略偏保守。前两条 122 是语速更慢的老配音。
 */
export const EPISODE_MS_PER_CHAR = 110

/**
 * 把文案切成【句子】，并给每一句配上"读到这里累计多久"。
 *
 * 拆主片/续集的一切都以句子为单位：AI 推荐的断点是句号，用户滚轮选的是句号，
 * 切出来的两段文本也在句号处接缝。所以**前后端必须用同一套切法**——
 * 句子编号在接口上传来传去，两边切得不一样，用户选的第 37 句和后端切的
 * 第 37 句就是两句话，而这种错位不会报错，只会让片子从奇怪的地方断开。
 * 这个模块就是那唯一一份切法。
 *
 * ⚠️【和 tts/split.ts 的切段是两回事】。那边是为了绕开 Azure 单次 10 分钟
 * 的硬上限，按"塞满 8 分钟"打包；这边是为了给人看、给人选，一句就是一句。
 * 两者的断句符号表保持一致，但用途不同，不要合并。
 */

/**
 * 句末符号。**逗号在此列**。
 *
 * ⚠️【这条流水线上的文案没有句号】。作者的写法是【一行一句、行尾一个逗号】
 * （多数是半角 `,`），从头到尾不用句号。实测三篇：8028 字里句末标点 1 个、
 * 5574 字里 0 个，而它们各有 328 行和 277 行，中位行长 17–22 字——
 * 结构和一篇"正常"的带句号文案（271 行、中位 18 字）一模一样，
 * 差别只在行尾敲的是 `。` 还是 `,`。
 *
 * 原来只认 `。！？；…`，于是这类文案整篇被切成 1 句，分集报"正文太短"，
 * 而用户面对的是五千多字的稿子。
 *
 * ⚠️【句号仍然留在表里】，不是为了兼容，是因为它本来就是句末——
 * 老项目里那篇带句号的照常切成 315 句，行为一个字都没变。
 *
 * 顿号 `、` 【不在】此列：它是列举分隔（"刀、剑、枪"），
 * 按它断会切出两三个字的碎句，而用户要在这些句子上滚动挑断点。
 *
 * 半角句点 `.` 也不在此列：它一分钱都不值——真用它结尾的行，行尾本来就有
 * 换行，照样会断；而它会把 `1.` `2.` 这类编号切成一字"句"。
 * （编号本身该由上游的清理层删掉，见 rename/deepseek.ts 的 chapterHeadings
 * 和复查里的"孤立数字行"。分句这一层不该替它擦屁股。）
 */
const SENTENCE_END = /[，,。！!？?；;…\n]/

export interface Sentence {
  /** 第几句，从 0 开始。接口上传的就是这个数 */
  index: number
  /** 句子原文，含句末标点 */
  text: string
  /** 这句话在原文里的起止（含头不含尾），切分文本时用它，不要靠拼接 */
  start: number
  end: number
  /** 从第一句读到【这句结束】的累计估算毫秒 */
  cumulativeMs: number
}

/**
 * 切句。空行和换行【不单独成句】：段落之间的空白跟着【下一句】走
 * （它是那一段的起头），文末残留的纯空白并进最后一句。两种情况下
 * 原文都是逐字保留的——这正是切分能拼回去的前提。
 *
 * 【返回 start/end 而不是只返回文本】：切主片/续集时必须能从原文里精确
 * 取出 [0, end) 和 [end, 全长)。靠 join 拼回去的话，句子之间的空白、换行
 * 会被悄悄改写，续集的开头可能凭空多出或少掉一个换行。
 */
export function splitSentences (
  text: string, msPerChar = EPISODE_MS_PER_CHAR,
): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  let cumulative = 0

  const push = (end: number): void => {
    const raw = text.slice(start, end)
    if (raw.trim() === '') {
      // 走到这儿只可能是文末的残留空白（段间空白会跟着下一句一起被切出来）
      if (out.length > 0) {
        const last = out[out.length - 1]!
        last.end = end
        last.text = text.slice(last.start, end)
      }
      start = end
      return
    }
    cumulative += Math.round(raw.trim().length * msPerChar)
    out.push({ index: out.length, text: raw, start, end, cumulativeMs: cumulative })
    start = end
  }

  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.test(text[i]!)) {
      // 句末标点后面可能还跟着引号/括号，一并算进这句
      let j = i + 1
      while (j < text.length && '」』"”）)》】'.includes(text[j]!)) j++
      push(j)
      i = j - 1
    }
  }
  if (start < text.length) push(text.length)
  return out
}

/** 总估算时长。等于最后一句的累计值 */
export function totalEstimatedMs (sentences: Sentence[]): number {
  return sentences.length === 0 ? 0 : sentences[sentences.length - 1]!.cumulativeMs
}

/**
 * 在第 index 句【之后】把文本切成两半。
 *
 * 返回的两段拼起来必须逐字等于原文——续集是接着讲的，中间掉一个字
 * 都会变成"说了半句话跳到下一句"。所以这里只做下标切片，不做任何清洗。
 */
export function cutAfter (text: string, sentences: Sentence[], index: number): {
  head: string; tail: string
} {
  const s = sentences[index]
  if (!s) return { head: text, tail: '' }
  return { head: text.slice(0, s.end), tail: text.slice(s.end) }
}
