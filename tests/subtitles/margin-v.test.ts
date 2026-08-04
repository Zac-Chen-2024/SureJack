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
    subtitleFontSize: 64, coverTitle: '', watermarkText: '', openingPickJson: '', openingState: 'settled' as const, subtitleCutsJson: '', splitDraftJson: '', inVideoTitle: '', parentProjectId: null, episodeIndex: 1, voiceName: 'zh-CN-XiaoxiaoNeural', voiceRate: 0, voiceVolume: 0, voicePitch: 0, subtitleMarginV: DEFAULT_SUBTITLE_MARGIN_V,
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
   * （screenshots/29226429….jpg）：【黑字白边】，读过和没读过一个颜色，
   * 描边宽度随字号缩放（0.075×字号，80 → 6）。
   *
   * 上一版是「白字黑边、已读转琥珀、描边写死 4」。
   */
  it('Sub 样式行逐字节钉死', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(styleLine(ass, 'Sub')).toBe(
      `Style: Sub,${FONT_FAMILY},81,&H00000000,&H00000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,5,0,2,60,60,999,1`
    )
    expect(DEFAULT_SUBTITLE_MARGIN_V).toBe(999)
  })

  /*
   * 标题和免责声明同样逐字节钉死。这三行是照参考图【逐像素拟合】出来的
   * （spikes/subtitle/，两层 IoU：外轮廓 + 字心），墨迹误差：
   * 标题 3px、字幕 1px、免责声明 0px（宽度）。
   */
  it('标题 165/描边7/离顶66，免责声明 56/描边2/离底19', () => {
    const ass = buildAss({
      lines, overlays: [
        { content: '标题', style: 'Title', startMs: null, endMs: null },
        { content: '声明', style: 'Disclaimer', startMs: null, endMs: null },
      ], aspect, durationMs: 1000, mode: 'karaoke',
    })
    const t = styleLine(ass, 'Title').split(',')
    expect([t[2], t[16], t[21]]).toEqual(['165', '7', '66'])
    const d = styleLine(ass, 'Disclaimer').split(',')
    expect([d[2], d[16], d[21]]).toEqual(['56', '2', '19'])
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
      expect(marginVOf(ass, 'Disclaimer')).toBe('19')
      expect(marginVOf(ass, 'Title')).toBe('66')
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
    expect(marginVOf(ass, 'Disclaimer')).toBe('19')
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

/**
 * 【老片子不重烧】的那道豁免。
 *
 * 母带指纹哈希的是 ASS 全文，样式行一改，所有历史项目的指纹立刻失效 →
 * 开机补合会把它们全部重烧一遍（十几分钟一条）。所以指纹改用【改版之前】
 * 的样式行来算：历史项目的指纹回到原值，盘上的成片继续有效；
 * 渲染仍然走新样式。
 *
 * 这一整行必须逐字节等于改版之前的字面量——差一个字符，豁免就失效，
 * 而症状是"机器莫名其妙忙了两个小时"，没人会想到是这里。
 */
describe('老样式豁免（算指纹用）', () => {
  it('legacyStyle 渲染出的三行样式 = 改版之前的字面量', () => {
    const ass = buildAss({
      lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke',
      subtitleMarginV: 300, subtitleFontSize: 64, legacyStyle: true,
    })
    /*
     * ⚠️ 这里【必须写死老族名】，不能用 FONT_FAMILY——那个常量现在是
     * Medium。历史项目的指纹是拿 'Noto Sans CJK SC' 算的，跟着常量走
     * 豁免立刻失效、十几条老片子全部重烧。
     */
    const LEGACY_FAMILY = 'Noto Sans CJK SC'
    expect(styleLine(ass, 'Sub')).toBe(
      `Style: Sub,${LEGACY_FAMILY},64,&H0000E5FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,2,60,60,300,1`
    )
    expect(styleLine(ass, 'Title')).toBe(
      `Style: Title,${LEGACY_FAMILY},96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0,100,100,0,0,1,6,0,8,60,60,120,1`
    )
    expect(styleLine(ass, 'Disclaimer')).toBe(
      `Style: Disclaimer,${LEGACY_FAMILY},32,&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,90,1`
    )
  })

  /*
   * ⚠️ ASS 支持 `;` 注释，但注释也进哈希。往样式块里加一行说明，
   * 所有历史项目的指纹就全变了——刚踩过一次。
   */
  it('样式块里不许有注释行', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    const block = ass.slice(ass.indexOf('[V4+ Styles]'), ass.indexOf('[Events]'))
    expect(block.split('\n').some((l) => l.trim().startsWith(';'))).toBe(false)
  })
})
