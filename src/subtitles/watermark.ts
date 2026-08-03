/**
 * 动态水印：一行半透明的小字，在画面六个角之间【匀速滑动】，防搬运。
 *
 * 【样式是逐像素拟合出来的】。参考是用户给的微信截图（screenshots/29226429….jpg）
 * 左上角那两个字，拟合脚本在 spikes/subtitle/watermark-fit2.py：
 *   单字亮框 31×32（参考 31×32）、字心不透明度 0.475（参考 0.479）
 * 拟合结论是 59 号 / 描边 0.3 @8%，但用户最后选的是【52 号 / 描边 2 @46%】——
 * 参考那圈边太淡，压在花背景上（地铁跑酷、火光）看不清，加粗描边后字号
 * 反而可以收小。所以这里的数不等于拟合值，是拟合之后人工定的一档。
 *
 * ⚠️【三个坑】
 *
 * 1 水印【不进指纹哈希的那份 ASS】（buildAss 的 legacyStyle 分支永远不画它）。
 *   母带指纹哈希 ASS 全文，往里加几十行 Dialogue，十几条历史成片立刻失效
 *   全部重烧。改成由 masterFingerprint 单独、且【只在水印非空时】追加
 *   watermarkText——没开水印的项目指纹逐字节不变，开了的才重烧。
 *
 * 2 【是滑动不是跳变】，所以定位不能用 \an + 边距那套（一条 Dialogue 只有
 *   一个对齐位，起点和终点的对齐位不同就没法表达）。改成统一 \an5（中心
 *   对齐）+ \move 两点坐标，坐标自己按文字宽高算——于是必须知道这行字
 *   在画面上占多大，见下面 measure 那几个比例常量。
 *
 * 3 水印走 Layer 0 且排在字幕【前面】，让字幕压在它上面。斜线路径会横穿
 *   画面中部，正是字幕所在的地方；水印盖住字幕比字幕盖住水印难受得多。
 */

/** 字号。比拟合出来的 59 小一点，配上更重的描边正好（用户选的第四档） */
export const WATERMARK_FONT_SIZE = 52

/** 描边宽度。参考里是 0.3 的淡边，用户要求加重到 2 并与字同透明度 */
export const WATERMARK_OUTLINE = 2

/**
 * 不透明度 46%（字和描边共用）。
 *
 * ⚠️ ASS 的 alpha 字节是【透明度】不是不透明度，要取反：
 * (1 − 0.46) × 255 = 138 = 0x8A。填反了会得到一个几乎不透明的水印。
 */
export const WATERMARK_ALPHA_HEX = '8A'

/** 离左右边 40、离上下边 30。参考里量到的是 41 / 31，取整 */
export const WATERMARK_MARGIN_H = 40
export const WATERMARK_MARGIN_V = 30

/*
 * 文字占多大——【实测出来的比例，不是猜的】。
 * 拿 \an5\pos(540,960) 真渲染「甲」「周周」「周周撸铁」三种长度量含描边外框：
 *   1 字 32×36    2 字 71×36    4 字 146×38   （字号 52）
 * → 首字约 0.63×字号，之后每字步进约 0.72×字号，高度约 0.70×字号。
 * 同一次还量到墨迹中心并不正好落在锚点上，差 (−1, +2.5)，一并校正。
 */
const FIRST_CHAR_RATIO = 0.63
const ADVANCE_RATIO = 0.72
const HEIGHT_RATIO = 0.70
const ANCHOR_DX = -1
const ANCHOR_DY = 2.5

export interface WatermarkAnchor {
  /** 给日志和测试看的中文名 */
  name: string
  hx: 'left' | 'right'
  vy: 'top' | 'middle' | 'bottom'
}

/**
 * 六个角，按用户给的顺序：左上 → 右边缘中间 → 左下 → 右上 → 左边缘中间 → 右下。
 *
 * 走的是对角线，相邻两个位置永远不在同一条边上——搬运的人想裁掉水印，
 * 得把四个角连同左右两条边都裁了，剩不下画面。
 */
export const WATERMARK_ANCHORS: WatermarkAnchor[] = [
  { name: '左上', hx: 'left', vy: 'top' },
  { name: '右中', hx: 'right', vy: 'middle' },
  { name: '左下', hx: 'left', vy: 'bottom' },
  { name: '右上', hx: 'right', vy: 'top' },
  { name: '左中', hx: 'left', vy: 'middle' },
  { name: '右下', hx: 'right', vy: 'bottom' },
]

/**
 * 每个位置【什么时候到达】。用户给的节点是 1分半 / 3分 / 6分 / 9分，
 * 加上开头的 0，正好 5 个；第六个（右下）用户没给，按前面的节奏（3 分一跳）
 * 外推到 12 分。
 *
 * ⚠️【是绝对时间，不随片长缩放】。用户说得很明白："如果不够长也按照这个
 * 时间分布来烧录"——四分钟的片子就只走到第三个位置，不把六段压缩进四分钟。
 */
export const WATERMARK_OFFSETS_MS = [0, 90_000, 180_000, 360_000, 540_000, 720_000]

/**
 * 一轮多长。12 分（到达右下）+ 3 分（沿用最后一段的间隔）= 15 分，
 * 之后回到左上重来一轮。用户说"如果更长就循环"。
 */
export const WATERMARK_CYCLE_MS = 900_000

export interface WatermarkSegment {
  /** 这一段从什么时候开始动 */
  startMs: number
  /** 画到什么时候为止（片子结束可能把它截断） */
  endMs: number
  /** 走完这一段【本该】花多久。截断时用它算速度，保证匀速不加急 */
  legMs: number
  from: WatermarkAnchor
  to: WatermarkAnchor
}

/**
 * 把时间轴切成一段段"从哪个角滑到哪个角"。
 *
 * 片子多长就切多长：短片自然只走前几段，长片按 WATERMARK_CYCLE_MS 循环。
 */
export function watermarkSegments (durationMs: number): WatermarkSegment[] {
  const out: WatermarkSegment[] = []
  if (!Number.isFinite(durationMs) || durationMs <= 0) return out
  const n = WATERMARK_ANCHORS.length
  for (let cycle = 0; cycle * WATERMARK_CYCLE_MS < durationMs; cycle++) {
    const base = cycle * WATERMARK_CYCLE_MS
    for (const [i, from] of WATERMARK_ANCHORS.entries()) {
      const startMs = base + (WATERMARK_OFFSETS_MS[i] ?? 0)
      if (startMs >= durationMs) break
      const nextMs = base + (WATERMARK_OFFSETS_MS[i + 1] ?? WATERMARK_CYCLE_MS)
      out.push({
        startMs,
        endMs: Math.min(nextMs, durationMs),
        legMs: nextMs - startMs,
        from,
        // 最后一个角滑向【下一轮的第一个角】，循环才接得上
        to: WATERMARK_ANCHORS[(i + 1) % n] as WatermarkAnchor,
      })
    }
  }
  return out
}

/**
 * 某个角上，水印用 \an5 定位时的锚点坐标。
 *
 * 贴边贴的是【看得见的墨迹】：先按文字长度算出它占多大，再把中心往里挪
 * 半个身位，最后补上锚点和墨迹中心那 1~2 像素的偏差。
 */
export function watermarkPoint (
  anchor: WatermarkAnchor, text: string, fontSize: number, width: number, height: number,
): { x: number; y: number } {
  const chars = Math.max(1, [...text].length)
  const boxW = fontSize * (FIRST_CHAR_RATIO + ADVANCE_RATIO * (chars - 1))
  const boxH = fontSize * HEIGHT_RATIO
  const x = anchor.hx === 'left'
    ? WATERMARK_MARGIN_H + boxW / 2 - ANCHOR_DX
    : width - WATERMARK_MARGIN_H - boxW / 2 - ANCHOR_DX
  const y = anchor.vy === 'top'
    ? WATERMARK_MARGIN_V + boxH / 2 - ANCHOR_DY
    : anchor.vy === 'bottom'
      ? height - WATERMARK_MARGIN_V - boxH / 2 - ANCHOR_DY
      : height / 2 - ANCHOR_DY
  return { x: Math.round(x), y: Math.round(y) }
}
