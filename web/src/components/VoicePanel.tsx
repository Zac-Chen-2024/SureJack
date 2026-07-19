import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconMic, IconCheck, IconLoader } from './ui/Icon'

const STATE_TEXT: Record<string, string> = {
  none: '还没生成', generating: '生成中…', ready: '已就绪',
  stale: '文案改过了，需要重新生成', error: '生成失败',
}

/**
 * 配音。**它是字幕栏的头部，不是一块独立的面板。**
 *
 * 字幕完全由配音的词级时间戳推导——它俩本来就是一件事。把生成按钮放在
 * 字幕列表正上方，用户不用在两栏之间来回看就知道「字幕为什么是空的」：
 * 原因和结果在同一个视野里。
 *
 * 所以这里是横向一行（状态在左、按钮在右）而不是原来的竖直卡片：
 * 头部要薄，把高度让给下面真正要读的字幕。
 */
export function VoicePanel () {
  const project = useProjects((s) => s.current())
  const reload = useProjects((s) => s.load)
  const { generateVoice, voiceBusy, voiceSegmentCount } = usePipeline()
  if (!project) return null

  const state = project.ttsState ?? 'none'
  const seconds = project.ttsDurationMs ? Math.round(project.ttsDurationMs / 1000) : null

  return (
    <div className="shrink-0 border-b border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
          <IconMic className="size-3.5" />配音
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          {state === 'ready' && <IconCheck className="size-3.5 shrink-0 text-accent" />}
          {state === 'generating' && <IconLoader className="size-3.5 shrink-0 animate-spin text-ink-400" />}
          <span className={`truncate ${state === 'stale' ? 'text-accent' : 'text-ink-100'}`}>
            {STATE_TEXT[state]}
          </span>
          {seconds !== null && state === 'ready' && (
            <span className="shrink-0 tabular-nums text-[11px] text-ink-400">
              {Math.floor(seconds / 60)} 分 {seconds % 60} 秒
            </span>
          )}
        </span>

        <Button
          variant={state === 'ready' ? 'ghost' : 'primary'}
          className="shrink-0"
          disabled={voiceBusy || !project.scriptText.trim()}
          onClick={async () => { await generateVoice(project.id); await reload() }}
        >
          {voiceBusy ? '生成中…' : state === 'none' ? '生成配音' : '重新生成'}
        </Button>
      </div>

      {voiceSegmentCount !== null && voiceSegmentCount > 1 && state === 'ready' && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          文案较长，已分 {voiceSegmentCount} 段合成并自动拼接。段落衔接处语气可能略有变化。
        </p>
      )}
    </div>
  )
}
