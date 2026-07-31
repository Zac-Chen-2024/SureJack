import { FONT_FAMILY } from '../config.js'
import type { SubtitleLine, TextOverlay, AspectPreset } from '../types.js'

/**
 * 字幕距底边的默认像素数（Sub 样式的 MarginV）。
 *
 * ⚠️ **300 是历史值，不能随手改**：它原本写死在下面的 Sub 样式行里，
 * 现在成了 projects.subtitle_margin_v 的列默认值。改这个数等于把所有
 * 没动过滑块的老项目的字幕集体挪一下位置——线上已经有真实成片了。
 */
/**
 * 字幕默认离画面底多远。
 *
 * 1000 = 参考图量出来的位置（screenshots/29226429….jpg，用户自己以前用剪映
 * 做的片子）：字幕落在画面中部偏下，而不是贴底。
 *
 * 【为什么中部比贴底好】：竖屏视频在各家 App 里，底部那一条都被进度条、
 * 头像、点赞栏、评论框占着；贴底的字幕在刷的时候经常被压住。抬到中部
 * 反而是"永远看得见"的位置。原来的 300 是凭感觉填的。
 */
export const DEFAULT_SUBTITLE_MARGIN_V = 999

export interface BuildAssOptions {
  lines: SubtitleLine[]
  overlays: TextOverlay[]
  aspect: AspectPreset
  durationMs: number
  mode: 'line' | 'karaoke'
  /**
   * 字幕距底边的像素数（配合 Alignment=2 底部居中）。缺省 = 历史值。
   *
   * 【只作用于 Sub】：免责声明也在底部，但它是固定的合规标记不是内容，
   * 用户把字幕往上推是为了避开背景里的人脸，跟合规标记摆在哪儿无关。
   * 见 tests/subtitles/margin-v.test.ts 里钉住这条的用例。
   *
   * 调用方（路由层）负责钳位——这里不再夹一次，免得两处规则各说各话。
   */
  subtitleMarginV?: number
  /** 正文字幕字号，ASS 单位（PlayRes 坐标系）。缺省 DEFAULT_SUBTITLE_FONT_SIZE */
  subtitleFontSize?: number
  /**
   * 隐藏标点字形（karaoke 模式）：标点仍用来断句、其 \kf 时长仍保留（停顿
   * 和扫光节奏一字不差），只是不把标点符号画出来。
   *
   * 缺省 false = 老行为（标点照画）。**这个开关只作用于【渲染】**——
   * 母带指纹那份 ASS 仍按 false 计算，从而老项目指纹不变、不会被补合重烧
   * （见 compose/film.ts：哈希用含标点版，烧录/预览用隐藏版）。
   */
  hidePunctuation?: boolean
  /**
   * ASS 的 WrapStyle。缺省 2 = 完全不自动换行（老行为，指纹那份要保持它）。
   * 渲染传 0 = 智能均分换行：一条字幕超过一行时自动折成两行，
   * 而不是靠"提前把句子切断"来避免溢出。
   */
  wrapStyle?: number
  /**
   * 用改版式【之前】的样式行。**只给算指纹用，绝不用于渲染**——
   * 它的作用是让历史项目的母带指纹回到改动之前的值，从而不被重烧。
   * 见 legacyStyleLines。
   */
  legacyStyle?: boolean
}

/**
 * 毫秒 → ASS 时间码 H:MM:SS.cc
 *
 * ⚠️ 必须先把毫秒舍入到整数厘秒（ASS 的时间精度），再用整数除法/取余
 * 逐级算出 h/m/s/cs。不能先算未舍入的 h/m，再对秒数单独 toFixed(2)——
 * 那样秒的四舍五入进位（如 59.999 → "60.00"）不会级联回分钟/小时，
 * 产出 "0:00:60.00" 这种非法时间码。全程整数运算，从根上避免这个问题。
 */
export function formatAssTime (ms: number): string {
  const totalCs = Math.round(Math.max(0, ms) / 10)
  const h = Math.floor(totalCs / 360000)
  const m = Math.floor((totalCs % 360000) / 6000)
  const s = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * 转义 ASS 纯文本，防止用户可编辑文案（标题、免责声明、字幕词）
 * 被当成 ASS 语法解析。
 *
 * ⚠️ 只能用于用户文本。我们自己生成的样式标签（如 buildKaraoke 产出的
 * `{\kf50}`）绝不能经过这个函数——那会把我们自己的合法标签也转义掉。
 *
 * 顺序很重要：反斜杠必须最先替换，否则会把后面替换 { } 换行时
 * 产生的反斜杠再次转义。
 */
export function escapeAssText (s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N')
}

/**
 * 生成卡拉OK扫光标签。
 *
 * ⚠️ 每个 \kf 的时长要【覆盖到下一个词的起点】，而不是本词的 duration。
 * 词之间存在空隙（停顿），若只用 duration，扫光会在空隙处停住，
 * 与音频脱节——听着念到了下一个词，画面上还没亮。
 *
 * ⚠️ 按【词】分组，不按字。Azure 给的就是词级时间戳（「震惊」是一个整词）。
 *
 * ⚠️ 隐性契约：这个函数假设 `line.words` 是真正的词级切分（每个 word
 * 是一个可以单独扫光的短语/词）。SRT 来源的 SubtitleLine（见 srt.ts）
 * 把整句话塞进一个"词"里（words 数组长度恒为 1），如果把它喂给
 * buildKaraoke，会产出一个覆盖整句时长的单个 \kf 标签——扫光效果会把
 * 整句话当一个字等比例扫光，跟真实语速完全脱节，但不会报错也不会崩溃，
 * 是纯视觉上的"能跑但错"。目前靠 cli.ts 的调用约定兜底（SRT 路径强制
 * `mode: 'line'`，从不传给这里），这个函数本身没有运行时校验——新增调用
 * 点（例如给 SRT 路径加一个 karaoke 选项）时，务必先确认 words 真的是
 * 词级而非句级切分。
 */
/**
 * 剔掉文本里【所有标点符号】，只留可读内容（汉字/字母/数字）。
 *
 * 为什么不能只靠 Azure 的 isPunctuation：那个标记只覆盖它自己单独切出来的
 * 逗号句号一类；**方括号【】、引号「」“”、书名号《》、破折号、省略号这些
 * 经常粘在词里**（"【第一章】他"是一个词），或者压根没被标记 → 于是字幕上
 * 就漏出括号。这里按 Unicode 标点类（\p{P}）一律剔除，才真正做到"字幕上
 * 不出现任何标点"。
 *
 * ⚠️ 两处豁免，都是为了【不损失内容】：
 *   · 不删 \p{S}（数学/货币符号）——否则 ￥50 变 50。
 *   · \p{P} 里有几个其实承载信息的字符要留：% / # & @ _ ~
 *     （百分号也在 Unicode 标点类里，删了 100% 就变成 100）。
 */
const KEEP = new Set(['%', '％', '/', '#', '&', '@', '_', '~'])

export function stripPunctuation (text: string): string {
  return [...text].filter((ch) => KEEP.has(ch) || !/\p{P}/u.test(ch)).join('')
}

export function buildKaraoke (line: SubtitleLine, hidePunctuation = false): string {
  return line.words.map((word, i) => {
    const next = line.words[i + 1]
    const spanMs = next ? next.offsetMs - word.offsetMs : word.durationMs
    // {\kf..} 是我们自己生成的标签，不转义；word.text 是用户/ASR 来的文本，要转义
    const tag = `{\\kf${Math.round(spanMs / 10)}}`   // ASS 的 \k 单位是厘秒
    /*
     * 隐藏标点：只留 \kf（时长照旧推进 → 停顿和扫光节奏一字不差），字形里
     * 一个标点都不留。两道都要做：
     *   ① Azure 单独切出来的标点词整个不画；
     *   ② 粘在词里的符号（【】「」《》—…等）用 stripPunctuation 剔掉——
     *      光靠 ① 会漏，这正是之前字幕上还看得到中括号的原因。
     * 剔完为空就只剩 \kf（时间照走、屏幕上什么都不显示）。
     */
    if (!hidePunctuation) return `${tag}${escapeAssText(word.text)}`
    if (word.isPunctuation) return tag
    const clean = stripPunctuation(word.text)
    return clean === '' ? tag : `${tag}${escapeAssText(clean)}`
  }).join('')
}

/**
 * 生成完整 ASS：字幕 + 固定文本，同一个文件。
 *
 * 设计文档第 7 节：字幕、标题、免责声明是同一个东西的不同填法，
 * 不需要两套机制。这个文件既喂给 ffmpeg 烧录，也喂给浏览器的 JASSUB 预览——
 * 同一个 libass，所以所见即所得是架构保证的，不是"努力对齐"出来的。
 *
 * 颜色格式是 &HAABBGGRR —— BGR 顺序，不是 RGB。经典陷阱。
 * PrimaryColour = 已唱色，SecondaryColour = 未唱色（不是字面意思上的"主/次"）。
 */
/**
 * 正文字幕的默认字号，ASS 单位（PlayResY=1920 的坐标系里）。
 *
 * 64 是这个项目一路用下来的值——所有已有项目的成片都是按它烧的，
 * 所以【默认值不能动】：改了会让每一条已有成片的指纹失效，
 * 全部重烧一遍十几分钟。
 */
/** 参考图拟合出来的字幕字号（墨迹 227×61，拟合 228×61，误差 1px） */
export const DEFAULT_SUBTITLE_FONT_SIZE = 81

/**
 * 标题 / 字幕 / 免责声明的字号、描边、位置。**全部是逐像素拟合出来的。**
 *
 * 参考是用户自己以前用剪映做的片子（screenshots/29226429….jpg）。做法和认
 * 封面字体那次一样：拿 libass 真渲染候选参数，和参考做两层 IoU
 * （外轮廓 + 字心）——只比外轮廓认不出描边宽度，描边加粗能把小字撑成
 * 大字的外形；两层一起比才唯一锁死【字号 + 描边】这一对。
 * 脚本在 spikes/subtitle/。
 *
 * 标定结果（成片坐标）：
 *   标题      字心 446×104  外框 461×118  → 字号 165 描边 7  离顶 66
 *   字幕      字心 217×51   外框 227×60   → 字号 81  描边 5  离底 999
 *   免责声明  外框 503×40                 → 字号 56  描边 2  离底 19
 *
 * ⚠️【三个坑，都是反复了好几轮才踩明白的】
 *
 * 1 阈值掩膜会把背景算成文字。参考图里微信的关闭按钮、画面中的暗块都被
 *   算了进去，外接框一度撑到整幅宽。解法是【按列切连通段】：文字是一串
 *   宽度相近、间距均匀的段，背景是孤立的一两段，一眼能分开。
 *
 * 2 描边定不出来，因为字心的大小和描边【无关】——描边是往外扩的。
 *   必须同时量【字心框】和【外框】，描边 = (外框宽 − 字心框宽) / 2。
 *
 * 3 两边的量法必须一致。参考的免责声明是靠"黑描边"框出来的（浅灰字压在
 *   很亮的背景上，只有描边够黑），那候选也得按黑描边量——拿字心去比外框，
 *   本身就差了两倍描边宽。
 */
export const TITLE_FONT_SIZE = 165
export const TITLE_OUTLINE = 7
export const TITLE_MARGIN_V = 66
export const DISCLAIMER_FONT_SIZE = 56
export const DISCLAIMER_OUTLINE = 2
export const DISCLAIMER_MARGIN_V = 19

/** 字幕描边 ÷ 字号。参考里 81 号字配 5px 描边 → 0.0617 */
export const SUBTITLE_OUTLINE_RATIO = 0.0617

/**
 * 字号的上下限。
 *
 * 下限 36：再小在手机上就得眯着眼看，而这类视频本来就是手机上刷的。
 * 上限 120：竖屏 1080 宽，120 号字一行只放得下 8 个汉字，
 * 再大就会让几乎每句话都折行，字幕反而占掉半个画面。
 */

/**
 * 改版式【之前】的样式行，逐字节保留。
 *
 * ⚠️【它存在的唯一理由是"老片子不重烧"】。母带指纹里哈希的是 ASS 全文，
 * 样式行一改，所有历史项目的指纹立刻失效 → 开机补合会把它们全部重烧一遍
 * （12 条 × 十几分钟）。而用户明确说了老片子保持原样。
 *
 * 所以：**哈希用这份老样式，渲染用新样式**。历史项目的指纹回到改动之前的
 * 值，盘上的成片继续有效；新项目、或任何改过字号/高度的项目，指纹本来就
 * 会变，自然按新样式烧。
 *
 * 同一个套路在字幕换行那次用过（LEGACY_SUBTITLE_MAX_CHARS）。
 */
function legacyStyleLines (fontSize: number, marginV: number): string {
  /*
   * ⚠️【族名也要写死成老的】。FONT_FAMILY 现在是 Medium，而历史项目的指纹
   * 是拿 'Noto Sans CJK SC' 算的——这里跟着常量走，豁免立刻失效、
   * 十几条老片子全部重烧。
   */
  const LEGACY_FAMILY = 'Noto Sans CJK SC'
  return [
    `Style: Sub,${LEGACY_FAMILY},${fontSize},&H0000E5FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,2,60,60,${marginV},1`,
    `Style: Title,${LEGACY_FAMILY},96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0,100,100,0,0,1,6,0,8,60,60,120,1`,
    `Style: Disclaimer,${LEGACY_FAMILY},32,&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,90,1`,
  ].join('\n')
}

export function buildAss (opts: BuildAssOptions): string {
  const { lines, overlays, aspect, durationMs, mode } = opts
  const marginV = opts.subtitleMarginV ?? DEFAULT_SUBTITLE_MARGIN_V
  const fontSize = opts.subtitleFontSize ?? DEFAULT_SUBTITLE_FONT_SIZE

  const dialogues = lines.map((line) => {
    // 整句模式（自备 SRT）也照同一条规则：字幕上不出现标点
    const text = mode === 'karaoke'
      ? buildKaraoke(line, opts.hidePunctuation)
      : line.words
        .map((w) => escapeAssText(opts.hidePunctuation === true ? stripPunctuation(w.text) : w.text))
        .join('')
    return `Dialogue: 0,${formatAssTime(line.startMs)},${formatAssTime(line.endMs)},Sub,,0,0,0,,${text}`
  })

  // Layer 1 > Layer 0：固定文本压在字幕之上，不会被盖住
  const overlayLines = overlays.map((o) => {
    const start = formatAssTime(o.startMs ?? 0)
    const end = formatAssTime(o.endMs ?? durationMs)
    return `Dialogue: 1,${start},${end},${o.style},,0,0,0,,${escapeAssText(o.content)}`
  })

  /*
   * Sub 的配色：【黑字白边】，读过和没读过一个样——用户要的就是这个。
   * 于是 \kf 的扫光在画面上看不出来了（两端同色），但那些标签仍然留着：
   * 它们决定每一行什么时候出现、什么时候换下一行，删了字幕就不动了。
   * 描边随字号缩放（0.075×字号），不写死 4——字号能调到 120，
   * 固定 4px 在大字上细得压不住背景。
   *
   * ⚠️【说明只能写在这儿，不能写进 ASS 正文】。ASS 支持 `;` 注释，但
   * 母带指纹哈希的是 ASS 全文——往里加一行注释，所有历史项目的指纹立刻
   * 失效，全部重烧。刚踩过。
   *
   * legacyStyle：只给【算指纹】用，见 legacyStyleLines 上面那段。
   * 渲染永远走新样式。
   */
  const styleLines = opts.legacyStyle === true
    ? legacyStyleLines(fontSize, marginV)
    : [
        `Style: Sub,${FONT_FAMILY},${fontSize},&H00000000,&H00000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(fontSize * SUBTITLE_OUTLINE_RATIO))},0,2,60,60,${marginV},1`,
        `Style: Title,${FONT_FAMILY},${TITLE_FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,0,0,0,0,100,100,0,0,1,${TITLE_OUTLINE},0,8,60,60,${TITLE_MARGIN_V},1`,
        `Style: Disclaimer,${FONT_FAMILY},${DISCLAIMER_FONT_SIZE},&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${DISCLAIMER_OUTLINE},0,2,60,60,${DISCLAIMER_MARGIN_V},1`,
      ].join('\n')

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${aspect.width}
PlayResY: ${aspect.height}
WrapStyle: ${opts.wrapStyle ?? 2}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${overlayLines.join('\n')}
${dialogues.join('\n')}
`
}
