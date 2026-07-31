import { describe, it, expect } from 'vitest'
import { ASPECT_PRESETS, FONT_FAMILY } from '../../src/config.js'
import { buildAss, DEFAULT_SUBTITLE_MARGIN_V } from '../../src/subtitles/ass.js'
import { buildAssForProject } from '../../src/subtitles/project-ass.js'
import type { Project } from '../../src/db/user-db.js'
import type { SubtitleLine } from '../../src/types.js'

const aspect = ASPECT_PRESETS['9:16']!
const lines: SubtitleLine[] = [{
  startMs: 0, endMs: 500,
  words: [{ text: '包子', offsetMs: 0, durationMs: 500, isPunctuation: false }],
}]

/**
 * 完整的 Project，字段一个不缺。
 * **不用 `as Project` 硬转**——那样漏字段/写错字段名类型检查一声不吭，
 * 一路跑到 ffmpeg 才炸（本项目为 fitMode 写成 fit 踩过这个坑）。
 */
function makeProject (patch: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: '测试项目', scriptText: '', aspectRatio: '9:16',
    ttsState: 'ready', ttsDurationMs: 8000,
    wordTimingsJson: JSON.stringify([
      { text: '包子', offsetMs: 0, durationMs: 500, isPunctuation: false },
    ]),
    bgmVolume: 0.1, bgmLibraryId: null, subtitleMode: 'karaoke',
    subtitleFontSize: 64, coverTitle: '', inVideoTitle: '', parentProjectId: null, episodeIndex: 1, voiceName: 'zh-CN-XiaoxiaoNeural', voiceRate: 0, voiceVolume: 0, voicePitch: 0, subtitleMarginV: DEFAULT_SUBTITLE_MARGIN_V,
    renameEnabled: false, renameState: 'none', renameAnalysisJson: null, renameMapJson: null,
    createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    ...patch,
  }
}

/** 取某个样式的整行，用来做逐字段比对 */
function styleLine (ass: string, name: string): string {
  const line = ass.split('\n').find((l) => l.startsWith(`Style: ${name},`))
  if (line === undefined) throw new Error(`ASS 里没有样式 ${name}`)
  return line
}

/** 样式行里的 MarginV 是【倒数第二个】字段（最后一个是 Encoding） */
function marginVOf (ass: string, name: string): string {
  const parts = styleLine(ass, name).split(',')
  const v = parts[parts.length - 2]
  if (v === undefined) throw new Error(`样式 ${name} 的字段数不对`)
  return v
}

describe('字幕纵向位置 —— ASS 样式行', () => {
  /*
   * 这一整行钉死字幕的观感。任何一次改动都必须是【有意的】，并且改完
   * 要连着这条断言一起改——它的作用不是禁止改，而是不许无声地改。
   *
   * 当前这版是照着用户自己以前用剪映做的片子量出来的
   * （screenshots/29226429….jpg）：未读【黑字】、描边【白色】，
   * 描边宽度随字号缩放（0.075×字号，64 → 5）。
   *
   * 上一版是「白字黑边、描边写死 4」。换成白边是因为白边在杂色画面上
   * 更能把字托出来；描边改成按比例，是因为字号能调到 120，
   * 固定 4px 在大字上细得压不住背景。
   */
  it('Sub 样式行逐字节钉死', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(styleLine(ass, 'Sub')).toBe(
      `Style: Sub,${FONT_FAMILY},80,&H0000E5FF,&H00000000,&H00FFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,6,0,2,60,60,1000,1`
    )
    expect(DEFAULT_SUBTITLE_MARGIN_V).toBe(1000)
  })

  /* 标题和免责声明的字号也是量出来的，同样钉死 */
  it('标题 160、免责声明 56——都是从参考图量出来的', () => {
    const ass = buildAss({
      lines, overlays: [
        { content: '标题', style: 'Title', startMs: null, endMs: null },
        { content: '声明', style: 'Disclaimer', startMs: null, endMs: null },
      ], aspect, durationMs: 1000, mode: 'karaoke',
    })
    expect(styleLine(ass, 'Title').split(',')[2]).toBe('160')
    expect(styleLine(ass, 'Disclaimer').split(',')[2]).toBe('56')
  })

  it('传进来的值进 Sub 样式行的 MarginV', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke', subtitleMarginV: 640 })
    expect(marginVOf(ass, 'Sub')).toBe('640')
    expect(ass).not.toContain(',60,60,300,1')   // 老值不该还留在 Sub 行里
  })

  it('0 是有效值——贴着底边，不能被当成"没传"回落成默认', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke', subtitleMarginV: 0 })
    expect(marginVOf(ass, 'Sub')).toBe('0')
  })

  /**
   * 免责声明【不跟着动】。
   *
   * 它也在底部（Alignment=2、MarginV=90），但它是**固定的合规标记，不是
   * 内容**——用户把字幕往上推，是为了避开背景里的人脸，跟合规标记摆在
   * 哪儿没有关系。让它跟着动，等于每调一次字幕就把免责声明也挪走一次。
   * 标题（Alignment=8，顶部）同理，压根不该受这个参数影响。
   */
  it('免责声明和标题的 MarginV 岿然不动', () => {
    const low = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke', subtitleMarginV: 0 })
    const high = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke', subtitleMarginV: 960 })
    for (const ass of [low, high]) {
      expect(marginVOf(ass, 'Disclaimer')).toBe('90')
      expect(marginVOf(ass, 'Title')).toBe('120')
    }
    expect(styleLine(low, 'Disclaimer')).toBe(styleLine(high, 'Disclaimer'))
    expect(styleLine(low, 'Title')).toBe(styleLine(high, 'Title'))
  })
})

describe('字幕纵向位置 —— buildAssForProject', () => {
  it('用项目存的值，不是写死的常数', () => {
    const ass = buildAssForProject(makeProject({ subtitleMarginV: 720 }))
    expect(marginVOf(ass, 'Sub')).toBe('720')
  })

  it('默认值的项目产出的 ASS 与不带这个字段时完全一致', () => {
    const ass = buildAssForProject(makeProject())
    expect(marginVOf(ass, 'Sub')).toBe(String(DEFAULT_SUBTITLE_MARGIN_V))
    expect(marginVOf(ass, 'Disclaimer')).toBe('90')
  })

  /** 项目名会被烧进画面：这个参数不许顺手把任何状态信息带进 Title 那一行 */
  it('Title 行的正文仍然只有项目名，没有掺进位置信息', () => {
    const ass = buildAssForProject(makeProject({ name: '豪门', subtitleMarginV: 640 }))
    const title = ass.split('\n').find((l) => l.startsWith('Dialogue: 1,') && l.includes(',Title,'))
    expect(title).toBeDefined()
    expect(title?.endsWith(',,豪门')).toBe(true)
    expect(title).not.toContain('640')
  })
})
