import { describe, it, expect } from 'vitest'
import { adoptSrtText } from '../../src/subtitles/from-srt.js'
import { deriveSubtitleLines, buildAssForProject } from '../../src/subtitles/project-ass.js'
import { DEFAULT_SUBTITLE_MARGIN_V } from '../../src/subtitles/ass.js'
import type { Project } from '../../src/db/user-db.js'

const SRT = `1
00:00:00,000 --> 00:00:02,000
第一句话，短。

2
00:00:02,500 --> 00:00:05,250
第二句稍微长一点，但也没有长到需要换行的程度。

3
00:00:06,000 --> 00:00:08,000
第三句
`

/**
 * 造一个完整的 Project。
 *
 * **不用 `as Project` 硬转**——那样漏字段/写错字段类型检查一声不吭，
 * 踩过（fitMode 误写成 fit，跑到 ffmpeg 才炸）。这里显式补齐所有字段，
 * 将来 Project 加列时这个函数会立刻编译不过，提醒改测试。
 */
function makeProject (patch: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: '测试项目', scriptText: '', aspectRatio: '9:16',
    ttsState: 'ready', ttsDurationMs: 8000, wordTimingsJson: null,
    bgmVolume: 0.1, bgmLibraryId: null, subtitleMode: 'karaoke',
    subtitleFontSize: 64, subtitleMarginV: DEFAULT_SUBTITLE_MARGIN_V,
    createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    ...patch,
  }
}

describe('adoptSrtText', () => {
  it('每条 cue 变成一个「词」，词数等于 cue 数', () => {
    const r = adoptSrtText(SRT)
    expect(r.cueCount).toBe(3)
    expect(r.words).toHaveLength(3)
    expect(r.words.map((w) => w.text)).toEqual([
      '第一句话，短。',
      '第二句稍微长一点，但也没有长到需要换行的程度。',
      '第三句',
    ])
  })

  it('偏移与时长直接来自 cue 的起止，且都是整数毫秒', () => {
    const r = adoptSrtText(SRT)
    expect(r.words[0]).toEqual({
      text: '第一句话，短。', offsetMs: 0, durationMs: 2000, isPunctuation: false,
    })
    expect(r.words[1]?.offsetMs).toBe(2500)
    expect(r.words[1]?.durationMs).toBe(2750)
    for (const w of r.words) {
      expect(Number.isInteger(w.offsetMs)).toBe(true)
      expect(Number.isInteger(w.durationMs)).toBe(true)
    }
  })

  it('lastEndMs 是最后一条 cue 的结束时间——用来跟配音时长比对', () => {
    expect(adoptSrtText(SRT).lastEndMs).toBe(8000)
  })

  it('剥 BOM：带 BOM 的文件不会少解析第一条', () => {
    expect(adoptSrtText('﻿' + SRT).cueCount).toBe(3)
  })

  it('解析不出内容时 cueCount 为 0，交由调用方给可操作的错误', () => {
    const r = adoptSrtText('这不是字幕文件，只是一段普通文本。')
    expect(r.cueCount).toBe(0)
    expect(r.words).toEqual([])
    expect(r.lastEndMs).toBe(0)
  })

  it('没有标点被单独标记——整句是一个词，isPunctuation 恒 false', () => {
    // 若哪天有人给 SRT 路径加了标点拆分，segmentLines 的标点断行逻辑
    // 会重新介入并打散原有分行，这条断言会先炸。
    expect(adoptSrtText(SRT).words.every((w) => !w.isPunctuation)).toBe(true)
  })
})

describe('line 模式的字幕派生：绝不重新断句', () => {
  it('自备 SRT 派生出的字幕行与 cue 一一对应，短句不会被合并', () => {
    const { words } = adoptSrtText(SRT)
    const project = makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'line',
    })
    const lines = deriveSubtitleLines(project)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.startMs)).toEqual([0, 2500, 6000])
    expect(lines.map((l) => l.endMs)).toEqual([2000, 5250, 8000])
  })

  it('两条都很短的相邻 cue 不会被并成一行——并行会跨过中间的静音', () => {
    // 这正是把 segmentLines 用在 SRT 结果上会犯的错：'甲'+'乙' 才 2 个字，
    // 远不到 14 字上限，会被攒进同一行，显示时间从 0 一路盖到 10 秒。
    const short = `1
00:00:00,000 --> 00:00:01,000
甲

2
00:00:09,000 --> 00:00:10,000
乙
`
    const { words } = adoptSrtText(short)
    const lines = deriveSubtitleLines(makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'line',
    }))
    expect(lines).toHaveLength(2)
    expect(lines[0]?.endMs).toBe(1000)
    expect(lines[1]?.startMs).toBe(9000)
  })

  it('超过 14 字的长 cue 也不会被切开——用户断好的行原样保留', () => {
    const { words } = adoptSrtText(SRT)
    const lines = deriveSubtitleLines(makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'line',
    }))
    expect(lines[1]?.words.map((w) => w.text)).toEqual([
      '第二句稍微长一点，但也没有长到需要换行的程度。',
    ])
  })

  it('karaoke 模式仍然走 segmentLines（词级时间轴照旧断句）', () => {
    const words = [
      { text: '震惊', offsetMs: 0, durationMs: 200, isPunctuation: false },
      { text: '他', offsetMs: 200, durationMs: 100, isPunctuation: false },
      { text: '竟然', offsetMs: 300, durationMs: 200, isPunctuation: false },
      { text: '，', offsetMs: 500, durationMs: 50, isPunctuation: true },
      { text: '走了', offsetMs: 550, durationMs: 200, isPunctuation: false },
    ]
    const lines = deriveSubtitleLines(makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'karaoke',
    }))
    expect(lines).toHaveLength(2)   // 标点处断行
    expect(lines[0]?.words).toHaveLength(4)
  })

  it('还没有任何时间轴时返回空数组，不抛错', () => {
    expect(deriveSubtitleLines(makeProject({ subtitleMode: 'line' }))).toEqual([])
  })
})

describe('自备 SRT 的 ASS 输出', () => {
  it('整句一条 Dialogue，不带任何 \\kf 扫光标签', () => {
    const { words } = adoptSrtText(SRT)
    const ass = buildAssForProject(makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'line',
    }))
    expect(ass).not.toContain('\\kf')
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))
    expect(dialogues).toHaveLength(3)
    expect(dialogues[0]).toContain('第一句话，短。')
    expect(dialogues[0]).toContain('0:00:00.00,0:00:02.00')
  })

  it('多行正文的 cue 在 ASS 里是 \\N 换行，不是裸换行（裸换行会截断 Dialogue 行）', () => {
    const multi = `1
00:00:00,000 --> 00:00:02,000
上面一行
下面一行
`
    const { words } = adoptSrtText(multi)
    const ass = buildAssForProject(makeProject({
      wordTimingsJson: JSON.stringify(words), subtitleMode: 'line',
    }))
    expect(ass).toContain('上面一行\\N下面一行')
  })
})
