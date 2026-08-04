import { describe, it, expect } from 'vitest'
import { segmentLines, applyCuts, overlongLines } from '../../src/subtitles/segment.js'
import type { WordTiming, SubtitleLine } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs: number, isPunctuation = false): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation })

describe('segmentLines', () => {
  it('在标点处断行——Azure 单独触发标点事件，断句是白送的', () => {
    const words = [
      w('震惊', 0, 500),
      w('！', 500, 100, true),
      w('包子', 600, 400),
      w('。', 1000, 100, true),
    ]
    const lines = segmentLines(words, 14)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('震惊！')
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('包子。')
  })

  it('标点留在它所属的那一行末尾，不甩到下一行开头', () => {
    const lines = segmentLines([w('好', 0, 100), w('。', 100, 50, true), w('坏', 150, 100)], 14)
    expect(lines[0]!.words.at(-1)!.text).toBe('。')
    expect(lines[1]!.words[0]!.text).toBe('坏')
  })

  it('超过字数上限强制断行——竖屏一行放不下太多字', () => {
    const words = Array.from({ length: 10 }, (_, i) => w('包子', i * 100, 100))
    const lines = segmentLines(words, 6)   // 每行最多 6 字 = 3 个「包子」
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      const chars = line.words.reduce((n, x) => n + [...x.text].length, 0)
      expect(chars).toBeLessThanOrEqual(6)
    }
  })

  it('行的起止时间完全由时间戳推导——首词起点到末词终点', () => {
    const lines = segmentLines([w('老陈', 250, 500), w('。', 750, 100, true)], 14)
    expect(lines[0]!.startMs).toBe(250)
    expect(lines[0]!.endMs).toBe(850)   // 750 + 100
  })

  it('空输入返回空数组，不崩', () => {
    expect(segmentLines([], 14)).toEqual([])
  })

  it('没有标点的长文本也能靠字数上限断开，不会产出一行超长字幕', () => {
    const words = Array.from({ length: 20 }, (_, i) => w('字', i * 100, 100))
    const lines = segmentLines(words, 5)
    expect(lines).toHaveLength(4)
  })

  it('末尾没有标点时也要 flush，不丢最后一行', () => {
    const lines = segmentLines([w('包子', 0, 500)], 14)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.words[0]!.text).toBe('包子')
  })

  it('非均匀词长下单行不超出 maxChars——老陈(2字)+包子铺(3字)，maxChars=4', () => {
    // 真实 Azure 中文分词的词长是 1-4 字不均匀的，"先 push 再判断" 会让
    // 最后一个词把行撑爆（2+3=5 > 4）。必须先判断再 push。
    const words = [w('老陈', 0, 500), w('包子铺', 500, 600)]
    const lines = segmentLines(words, 4)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('老陈')
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('包子铺')
    for (const line of lines) {
      const chars = line.words.reduce((n, x) => n + [...x.text].length, 0)
      expect(chars).toBeLessThanOrEqual(4)
    }
  })

  it('连续标点不产出只有标点的孤行，附回上一行末尾并延长 endMs', () => {
    const words = [
      w('老陈', 0, 500),
      w('！', 500, 100, true),
      w('？', 600, 80, true),
      w('好', 680, 100),
    ]
    const lines = segmentLines(words, 4)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('老陈！？')
    expect(lines[0]!.endMs).toBe(680)   // 600 + 80，跟着最后一个标点延长
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('好')
  })

  it('单个词本身超过 maxChars 时独占一行且允许超限（已知边界，非漏洞）', () => {
    const words = [w('包子铺老板', 0, 500), w('好', 500, 100)]
    const lines = segmentLines(words, 4)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('包子铺老板')
    expect(lines[0]!.words.reduce((n, x) => n + [...x.text].length, 0)).toBe(5)
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('好')
  })

  it('maxChars <= 0 直接抛错，不静默退化成逐词断行', () => {
    expect(() => segmentLines([w('包子', 0, 500)], 0)).toThrow()
    expect(() => segmentLines([w('包子', 0, 500)], -1)).toThrow()
  })
})

describe('语义切分的落地：吸附词边界', () => {
  /** 造一行：每个词 2 字、每词 500ms */
  const line = (texts: string[]): SubtitleLine => ({
    startMs: 0,
    endMs: texts.length * 500,
    words: texts.map((t, i) => ({ text: t, offsetMs: i * 500, durationMs: 500, isPunctuation: false })),
  })
  const textsOf = (ls: SubtitleLine[]): string[] => ls.map((l) => l.words.map((w) => w.text).join(''))

  const L = line(['他把', '那只', '木箱', '推到', '墙角'])   // 10 字，5 个词，缝在 2/4/6/8

  it('断点正好落在词缝上 → 原样切开', () => {
    expect(textsOf(applyCuts(L, [6]))).toEqual(['他把那只木箱', '推到墙角'])
  })

  /*
   * ⚠️ 模型看到的是纯文本，它不知道 Azure 把哪几个字当一个词。
   * 切在词中间就没有时间戳可用了——必须吸附到最近的那条缝。
   */
  it('断点落在词中间 → 吸到最近的缝', () => {
    expect(textsOf(applyCuts(L, [5]))).toEqual(['他把那只木箱', '推到墙角'])   // 4 和 6 等距 → 取靠后
    expect(textsOf(applyCuts(L, [7]))).toEqual(['他把那只木箱推到', '墙角'])   // 6 和 8 等距 → 取靠后
  })

  it('切多刀', () => {
    expect(textsOf(applyCuts(L, [4, 8]))).toEqual(['他把那只', '木箱推到', '墙角'])
  })

  it('时间轴跟着词走，不是平均分的', () => {
    const [a, b] = applyCuts(L, [6])
    expect(a!.startMs).toBe(0)
    expect(a!.endMs).toBe(1500)     // 第 3 个词结束
    expect(b!.startMs).toBe(1500)
    expect(b!.endMs).toBe(2500)
  })

  it.each([
    ['落在开头', [0]],
    ['落在末尾', [10]],
    ['超出范围', [99]],
    ['负数', [-3]],
  ])('%s 的断点丢掉，不产出空行', (_label, pts) => {
    expect(applyCuts(L, pts)).toHaveLength(1)
  })

  it('两个断点吸到同一条缝 → 只算一刀', () => {
    expect(applyCuts(L, [5, 6])).toHaveLength(2)
  })
})

describe('挑出机械切完仍然超限的行', () => {
  it('有标点的早就断干净了，只有硬断出来的才要送去语义切', () => {
    const words: WordTiming[] = [
      { text: '短句', offsetMs: 0, durationMs: 100, isPunctuation: false },
      { text: '。', offsetMs: 100, durationMs: 10, isPunctuation: true },
      ...Array.from({ length: 12 }, (_, i) => ({
        text: '长', offsetMs: 200 + i * 100, durationMs: 100, isPunctuation: false,
      })),
    ]
    const lines = segmentLines(words, 12)
    const over = overlongLines(lines, 8)
    expect(over.length).toBeGreaterThan(0)
    // 那条短的不该被挑出来
    expect(over).not.toContain(0)
  })
})

describe('超限判断按【屏幕上真正显示的字】算', () => {
  /*
   * ⚠️ 线上真遇到：弹幕体小说里一行是
   *   原始词表：「】 【人类和人鱼在一起不能孕育后代，」= 17 字
   *   屏幕上：  「人类和人鱼在一起不能孕育后代」    = 14 字
   * 渲染时 hidePunctuation 会把标点字形全去掉，所以那一行压根放得下。
   * 按带标点的长度判超限，等于为放得下的行白花一次 LLM 调用、还多断一次。
   */
  const line = (texts: Array<[string, boolean]>): SubtitleLine => ({
    startMs: 0,
    endMs: 1000,
    words: texts.map(([t, p], i) => ({
      text: t, offsetMs: i * 100, durationMs: 100, isPunctuation: p,
    })),
  })

  it('标点不算进长度', () => {
    const l = line([['】', true], ['【', true], ['人类和人鱼在一起', false],
      ['不能孕育后代', false], ['，', true]])
    // 带标点 17 字，去掉标点 14 字
    expect(overlongLines([l], 15)).toEqual([])
  })

  it('粘在词里的括号也不算——Azure 不会把它们单独切出来', () => {
    const l = line([['【人类】', false], ['和人鱼在一起不能孕育后代', false]])
    expect(overlongLines([l], 15)).toEqual([])
  })

  it('真超限的还是要挑出来', () => {
    const l = line([['一二三四五六七八九十一二三四五六七八', false]])
    expect(overlongLines([l], 17)).toEqual([0])
  })
})
