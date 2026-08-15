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
  /**
   * 母带只出画面、不带音轨。配音和音乐留到混音那一步各自进来，
   * 于是两边的音量都能几秒改一次，而不是重烧十几分钟。
   */
  silentMaster?: boolean
  clips: Clip[]
  voicePath: string
  bgmPath?: string
  bgmVolume: number
  assPath: string
  aspect: AspectPreset
  durationMs: number
  /**
   * 【在这一毫秒强制放一个关键帧】。为「重选开头」服务:
   * `-c copy` 只能从关键帧切开,而实测母带的关键帧平均 7.7 秒才有一个,
   * 分界处几乎必然没有。没有这一帧,后半段就切不干净,重选开头只能整条重烧。
   *
   * ⚠️【不给就一个参数都不加】。这是给老项目的隔离:多一个 `-force_key_frames`
   * 会让编码结果逐字节不同,而老片子必须保持原样。
   */
  keyframeAtMs?: number | null
  /**
   * `-t` 精确到毫秒(而不是默认的 0.1 秒)。**重选开头时必须为 true**:
   * 头段要正好等于分界,长一帧后面整条字幕就相对配音偏 33 毫秒。
   * 平时不传——改了会让重烧出来的片子和从前差一帧。
   */
  exactDuration?: boolean
  outPath: string
}
