import type { ReactNode, SVGProps } from 'react'

/**
 * SVG 图标系统。全部是线性（stroke-based）图标，风格参考 Lucide/Feather 那种
 * 几何简洁的线条感，但每一个 path 都是照着这套规范手写的，不是抄库。
 *
 * 统一规范（别在某个图标上"抖机灵"破坏一致性）：
 *   - stroke="currentColor"：颜色跟随文字色，天然适配 hover/disabled/主题
 *   - stroke-width 1.5、round cap/join：线头线角统一，避免有的图标看起来更"粗"
 *   - viewBox 0 0 24 24：所有图标共享同一套坐标系，混排时视觉重量一致
 *   - 默认尺寸 size-4（Tailwind），通过 className 覆盖——图标和文字并排时
 *     不应该比文字还高，一般 size-4 配 text-sm
 */
function Svg ({ className = 'size-4', children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  )
}

type IconProps = SVGProps<SVGSVGElement>

/** 新建项目 */
export function IconPlus (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

/** 侧栏收起 */
export function IconChevronLeft (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  )
}

/** 侧栏展开 */
export function IconChevronRight (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  )
}

/** 删除项目——比 × 更明确地表达"删除"而不是"关闭" */
export function IconTrash (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
      <path d="M6.5 7l.7 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9L18.5 7" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

/** 登出 */
export function IconLogOut (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </Svg>
  )
}

/** 空状态——文档/文案的意象 */
export function IconFileText (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h6.379a1.5 1.5 0 0 1 1.06.44l3.622 3.62A1.5 1.5 0 0 1 17 8.12V19.5A1.5 1.5 0 0 1 15.5 21h-10A1.5 1.5 0 0 1 4 19.5v-15Z" />
      <path d="M12 3.4V7a1 1 0 0 0 1 1h3.6" />
      <path d="M8 13.5h8M8 16.5h5" />
    </Svg>
  )
}

/** "已保存"状态的对勾 */
export function IconCheck (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 13l4.5 4.5L19 7" />
    </Svg>
  )
}

/** "保存中"的加载态——配 className="animate-spin" 使用 */
export function IconLoader (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Svg>
  )
}

/** 上传素材 */
export function IconUpload (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Svg>
  )
}

/** 配音 */
export function IconMic (props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </Svg>
  )
}

/** 背景视频素材 */
export function IconFilm (props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </Svg>
  )
}

/** 背景音乐素材 */
export function IconMusic (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </Svg>
  )
}

/** 字幕——取「画面下方两行字」的意象，与 IconFilm 的矩形语汇同源 */
export function IconSubtitles (props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 12h5M15 12h2M7 15.5h2M12 15.5h5" />
    </Svg>
  )
}

/** 下载成片 */
export function IconDownload (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Svg>
  )
}

/** 播放——预览区的意象。三角形用和其它图标一样的圆角线头，不做实心填充 */
export function IconPlay (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5.6v12.8L18.6 12 8 5.6Z" />
    </Svg>
  )
}

/** 音量 / 混音平衡 */
export function IconVolume (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" />
    </Svg>
  )
}

/** 暂停 */
export function IconPause (props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  )
}

/** 预览——取景框的意象，和 IconFilm（素材）区分开 */
export function IconPreview (props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M10 17.5h4" />
    </Svg>
  )
}
