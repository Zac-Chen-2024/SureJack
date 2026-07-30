import { describe, it, expect } from 'vitest'
import { splitSentences, cutAfter, totalEstimatedMs } from '../../src/episodes/sentences.js'
import { splitStory, sequelTitles, buildReminder } from '../../src/episodes/split.js'
import { allowedRange, coerceSplitPlan, TARGET_MIN_MS, TARGET_MAX_MS } from '../../src/episodes/split-ai.js'
import { EPISODE_MS_PER_CHAR } from '../../src/episodes/sentences.js'

const STORY = '第一句话。第二句话！第三句话？第四句话；第五句话。第六句话。'

describe('切句', () => {
  it('按句末标点切，标点跟在句末', () => {
    const s = splitSentences(STORY)
    expect(s.map((x) => x.text)).toEqual(
      ['第一句话。', '第二句话！', '第三句话？', '第四句话；', '第五句话。', '第六句话。'])
  })

  /* 逗号处断句，读起来是话没说完就切走了。这条守住"逗号不是句末" */
  it('逗号不算句末', () => {
    expect(splitSentences('他站住了，回头看了一眼。')).toHaveLength(1)
  })

  it('句末标点后的引号括号算进这一句', () => {
    const s = splitSentences('他说：“走吧。”然后走了。')
    expect(s[0]!.text).toBe('他说：“走吧。”')
  })

  it('累计时长逐句递增，最后一句等于全文估算', () => {
    const s = splitSentences(STORY)
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.cumulativeMs).toBeGreaterThan(s[i - 1]!.cumulativeMs)
    }
    expect(totalEstimatedMs(s)).toBe(s.length * 5 * EPISODE_MS_PER_CHAR)
  })

  /*
   * 【切出来的两半必须逐字拼回原文】。中间掉一句，观众听到的就是
   * "说了半句跳到下一段"——而两边各自都通顺，预览里极难发现。
   */
  it('cutAfter 的两半拼回去逐字等于原文', () => {
    const s = splitSentences(STORY)
    for (let i = 0; i < s.length; i++) {
      const { head, tail } = cutAfter(STORY, s, i)
      expect(head + tail).toBe(STORY)
    }
  })

  /*
   * 段间空白跟着【下一句】走——它是那一段的起头。无论跟前跟后，
   * 关键是原文逐字保留，切开还能拼回去（上面那条已经守住）。
   */
  it('空行不单独成句，跟着下一句走', () => {
    const s = splitSentences('第一句。\n\n第二句。')
    expect(s).toHaveLength(2)
    expect(s[0]!.text).toBe('第一句。')
    expect(s[1]!.text).toBe('\n\n第二句。')
    expect(s[0]!.text + s[1]!.text).toBe('第一句。\n\n第二句。')
  })
})

describe('拆故事', () => {
  const opts = { text: STORY, breakIndex: 2, introEndIndex: 0, mainInVideoTitle: '豪门' }

  it('主片到断点句为止', () => {
    expect(splitStory(opts).mainText).toBe('第一句话。第二句话！第三句话？')
  })

  it('续集 = 引子 + 提醒语 + 断点之后', () => {
    expect(splitStory(opts).sequelText).toBe(
      '第一句话。\n周周提醒你，豪门第二集开始啦。\n第四句话；第五句话。第六句话。')
  })

  /*
   * 【三段之间必须是换行，不能是空格】。配音断句和字幕分行都看标点，
   * 空格既不产生停顿也不换行——提醒语会和引子最后一句黏成一句读出来。
   */
  it('三段之间是换行', () => {
    const t = splitStory(opts).sequelText
    expect(t.split('\n')).toHaveLength(3)
  })

  /*
   * 引子越过断点的话，续集会把主片还没讲到的内容先剧透一遍，
   * 而且提醒语之后的正文和引子重叠。
   */
  it('【引子不会越过断点】越过就剧透了', () => {
    const r = splitStory({ ...opts, introEndIndex: 5 })
    // 断点是 2，引子最多到第 1 句
    expect(r.sequelText.startsWith('第一句话。第二句话！\n周周提醒')).toBe(true)
  })

  it('断点越界会被夹回最后一句', () => {
    expect(splitStory({ ...opts, breakIndex: 999 }).mainText).toBe(STORY)
  })
})

describe('续集的标题', () => {
  it('项目名加 2，封面和片内标题跟着片内标题加 2', () => {
    expect(sequelTitles({ name: '豪门归来', inVideoTitle: '她回来了' })).toEqual({
      name: '豪门归来2', coverTitle: '她回来了2', inVideoTitle: '她回来了2',
    })
  })

  it('没填片内标题就用项目名推', () => {
    expect(sequelTitles({ name: '豪门归来', inVideoTitle: '' }).coverTitle).toBe('豪门归来2')
  })

  /* 提醒语用【片内标题】——那是观众在第一集屏幕上一直看着的那行字 */
  it('提醒语填的是片内标题', () => {
    expect(buildReminder('她回来了')).toBe('周周提醒你，她回来了第二集开始啦。')
  })
})

describe('断点的合法范围', () => {
  /*
   * 【估算用的是实测值 110ms/字，不是切段那个 196】。用 196 的话
   * "7–10 分钟"实际会切出 4–6 分钟的片子——真机上就是这么翻车的。
   */
  it('每字毫秒用的是实测校准值', () => {
    expect(EPISODE_MS_PER_CHAR).toBeGreaterThan(100)
    expect(EPISODE_MS_PER_CHAR).toBeLessThan(120)
  })

  /** 造一篇够长的文：每句 50 字，n 句 */
  const longStory = (n: number): string => Array.from({ length: n }, () => `${'字'.repeat(49)}。`).join('')

  it('取估算时长落在 7–10 分钟之间的那些句子', () => {
    const s = splitSentences(longStory(300))
    const { min, max } = allowedRange(s)
    expect(s[min]!.cumulativeMs).toBeGreaterThanOrEqual(TARGET_MIN_MS)
    expect(s[max]!.cumulativeMs).toBeLessThanOrEqual(TARGET_MAX_MS)
  })

  /*
   * 【全文不到 7 分钟也要能拆】。硬求这个区间会得到空集合、接口只能报错，
   * 可用户明明只是写了一篇短文。退成中段，两集都短但仍然成立。
   */
  it('全文比一集还短时退成中段，不报错', () => {
    const s = splitSentences(longStory(10))
    const { min, max } = allowedRange(s)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(s.length)
    expect(min).toBeLessThanOrEqual(max)
  })
})

describe('模型返回的收拢', () => {
  const s = splitSentences(Array.from({ length: 100 }, (_, i) => `第${i}句。`).join(''))
  const allowed = { min: 30, max: 60 }

  /*
   * 模型偶尔报越界的句号（全文 100 句却回 512）。不夹的话会切出一个空的
   * 续集——界面上表现为"续集是空白项目"，没人会想到是模型多报了个数。
   */
  it('越界的候选被夹回合法范围', () => {
    const r = coerceSplitPlan({ candidates: [{ sentenceIndex: 512, reason: 'x' }] }, s, allowed)
    expect(r.candidates[0]!.sentenceIndex).toBe(60)
  })

  it('重复的候选去重，并按句子顺序排', () => {
    const r = coerceSplitPlan({
      candidates: [
        { sentenceIndex: 50, reason: 'b' },
        { sentenceIndex: 40, reason: 'a' },
        { sentenceIndex: 50, reason: '重复' },
      ],
    }, s, allowed)
    expect(r.candidates.map((c) => c.sentenceIndex)).toEqual([40, 50])
  })

  it('引子不会超过全文四分之一', () => {
    const r = coerceSplitPlan({ introEndIndex: 90 }, s, allowed)
    expect(r.introEndIndex).toBeLessThanOrEqual(25)
  })

  it('缺字段也不炸，给得出兜底值', () => {
    const r = coerceSplitPlan({}, s, allowed)
    expect(r.candidates).toEqual([])
    expect(Number.isInteger(r.introEndIndex)).toBe(true)
  })

  it('没写理由时给一句占位，不留空', () => {
    const r = coerceSplitPlan({ candidates: [{ sentenceIndex: 40 }] }, s, allowed)
    expect(r.candidates[0]!.reason).not.toBe('')
  })
})
