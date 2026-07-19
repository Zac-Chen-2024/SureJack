import { useProjects } from '../store/projects'
import { IconSubtitles } from './ui/Icon'

/**
 * 时间 · 字幕列表（文案列的下半）。
 *
 * TODO(Task 2)：目前只有列头和空状态骨架，没有真实数据。
 * 完整实现见 docs/superpowers/plans/2026-07-19-workspace-relayout.md 的 Task 2：
 *   - 新建 web/src/store/subtitles.ts，拉 GET /api/projects/:id/subtitles
 *   - 每行「时间戳 + 字幕文字」，时间戳 tabular-nums / ink-400，文字 ink-100
 *   - 当前播放行：ink-700 背景 + 左侧 2px accent 竖条（不要整行染琥珀）
 *   - 点击行 → 预览跳到该时间点（经 store 与 Task 3 的 Preview 通信）
 *   - 列表 overflow-y-auto，当前行 scrollIntoView({ block: 'nearest' })
 */
export function SubtitleList () {
  const project = useProjects((s) => s.current())
  const voiceReady = project?.ttsState === 'ready'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-[11px] uppercase tracking-wider text-ink-400">
        <IconSubtitles className="size-3.5" />
        时间 · 字幕
      </div>

      {/*
        空状态不是空白。「字幕不用手写、由配音的词时间轴推出来」是本产品的核心
        设定，用户第一次看到这一栏时必须被告知，否则只会觉得这里坏了。
      */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-6">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <IconSubtitles className="size-7 text-ink-600" />
          <p className="max-w-[30ch] text-xs leading-relaxed text-ink-400">
            {voiceReady
              ? '配音时间轴已就绪，字幕行稍后显示在这里。'
              : '字幕由配音时间轴自动生成，不用手写。先生成配音，这里就会出现每一行的时间和文字。'}
          </p>
        </div>
      </div>
    </div>
  )
}
