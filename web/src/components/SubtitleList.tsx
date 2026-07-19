import { useEffect, useRef } from 'react'
import {
  useSubtitles, formatTimestamp, findCurrentLineIndex, lineText,
} from '../store/subtitles'
import { IconSubtitles, IconLoader } from './ui/Icon'

/**
 * 字幕时间列表。
 *
 * 本产品的核心设定：字幕【完全由配音时间轴推导】，不手写、不可编辑。
 * 所以这个列表是只读的索引视图——左边时间、右边文字，点一行跳到那个
 * 时间点。它的价值不是"编辑字幕"，是"按时间检索自己的片子"。
 */
export function SubtitleList () {
  const lines = useSubtitles((s) => s.lines)
  const currentMs = useSubtitles((s) => s.currentMs)
  const loading = useSubtitles((s) => s.loading)
  const error = useSubtitles((s) => s.error)
  const seekTo = useSubtitles((s) => s.seekTo)

  const currentIndex = findCurrentLineIndex(lines, currentMs)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // 当前行变化时把它滚进视野。block: 'nearest' 而不是 'center'——
  // center 会在每次高亮前移时把列表重新居中，播放时列表一直在动，看着晕。
  // nearest 只在当前行真的滚出视野时才动，安静得多。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] uppercase tracking-wider text-ink-400">
        <IconSubtitles className="size-3.5" />
        字幕
        {loading
          ? <IconLoader className="size-3 animate-spin" />
          : lines.length > 0 && <span className="tabular-nums">{lines.length} 行</span>}
      </div>

      {error !== null
        ? <Notice text={error} />
        : lines.length === 0
          ? (loading ? null : <Notice text="字幕由配音时间轴自动生成，先生成配音" />)
          : (
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              {lines.map((line, i) => {
                const active = i === currentIndex
                return (
                  <button
                    key={line.startMs}
                    ref={active ? activeRef : null}
                    type="button"
                    onClick={() => seekTo(line.startMs)}
                    aria-current={active ? 'true' : undefined}
                    className={[
                      // 左侧那条 2px 竖条：非当前行也占同样的位置，只是透明。
                      // 否则高亮时整行文字会横向抖 2px。
                      'flex w-full items-baseline gap-2.5 border-l-2 py-1 pr-3 pl-2.5 text-left',
                      active
                        ? 'border-accent bg-ink-700'
                        : 'border-transparent hover:bg-ink-850',
                    ].join(' ')}
                  >
                    {/* 时间是索引，不是内容：压暗、等宽数字、右对齐，
                        让一列时间戳在视觉上收成一条安静的标尺 */}
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-400">
                      {formatTimestamp(line.startMs)}
                    </span>
                    <span className="min-w-0 text-sm leading-relaxed break-words text-ink-100">
                      {lineText(line)}
                    </span>
                  </button>
                )
              })}
            </div>
            )}
    </div>
  )
}

/** 空态/错误态的说明文字。空白屏幕不解释任何事，一句话才解释。 */
function Notice ({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
      <p className="max-w-[15rem] text-center text-xs leading-relaxed text-ink-400">{text}</p>
    </div>
  )
}
