/** Azure WordBoundary 事件，已归一化：偏移量单位是毫秒，文本已反转义 */
export interface WordTiming {
  text: string
  offsetMs: number
  durationMs: number
  isPunctuation: boolean
}

/** TTS 结果。时间的唯一来源。 */
export interface TtsResult {
  audioPath: string
  durationMs: number
  words: WordTiming[]
}

/** 一行字幕。推导数据——不入库，每次从 WordTiming 算出来。 */
export interface SubtitleLine {
  startMs: number
  endMs: number
  words: WordTiming[]
}

export type FitMode = 'cover' | 'contain' | 'blur'

/** 一个背景视频片段 */
export interface Clip {
  path: string
  fitMode: FitMode
  /**
   * 裁切窗口的水平/竖直插值比例，范围 0..1（默认 0.5）。仅 cover 模式有意义。
   * 语义：窗口在可行范围内的位置比例。0=贴源图左/上边缘，1=贴右/下边缘，0.5=精确居中。
   * 实现公式：左上角=(源宽-窗宽)*X，与 CSS object-position 百分比语义同义。
   * ⚠️ 将来写前端预览滑块时，务必按插值而非「中心像素/源宽」实现，否则预览与成片坐标会不一致。
   */
  cropOffsetX: number
  cropOffsetY: number
  /** 源视频自身的裁剪，用于切掉烧死的字幕等。可空 */
  sourceCrop?: { w: number; h: number; x: number; y: number }
}

/** 固定位置文本：标题、免责声明。与字幕共用一个 ASS 文件 */
export interface TextOverlay {
  content: string
  style: 'Title' | 'Disclaimer'
  /** null = 全程常驻 */
  startMs: number | null
  endMs: number | null
}

export interface AspectPreset {
  name: string
  width: number
  height: number
}

/** 渲染作业的完整描述 */
export interface RenderJob {
  clips: Clip[]
  voicePath: string
  bgmPath?: string
  bgmVolume: number
  assPath: string
  aspect: AspectPreset
  durationMs: number
  outPath: string
}
