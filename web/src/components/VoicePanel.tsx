import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconMic, IconCheck, IconLoader } from './ui/Icon'

const STATE_TEXT: Record<string, string> = {
  none: '还没生成', generating: '生成中…', ready: '已就绪',
  stale: '文案改过了，需要重新生成', error: '生成失败',
}

export function VoicePanel () {
  const project = useProjects((s) => s.current())
  const reload = useProjects((s) => s.load)
  const { generateVoice, voiceBusy } = usePipeline()
  if (!project) return null

  const state = project.ttsState ?? 'none'
  const seconds = project.ttsDurationMs ? Math.round(project.ttsDurationMs / 1000) : null

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconMic className="size-3.5" />配音
      </div>
      <div className="rounded-lg border border-line bg-ink-850 px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          {state === 'ready' && <IconCheck className="size-3.5 text-accent" />}
          {state === 'generating' && <IconLoader className="size-3.5 animate-spin text-ink-400" />}
          <span className={state === 'stale' ? 'text-accent' : 'text-ink-100'}>{STATE_TEXT[state]}</span>
        </div>
        {seconds !== null && state === 'ready' && (
          <div className="mt-0.5 text-[11px] tabular-nums text-ink-400">
            {Math.floor(seconds / 60)} 分 {seconds % 60} 秒
          </div>
        )}
      </div>
      <Button
        variant={state === 'ready' ? 'ghost' : 'primary'}
        className="mt-1.5 w-full"
        disabled={voiceBusy || !project.scriptText.trim()}
        onClick={async () => { await generateVoice(project.id); await reload() }}
      >
        {voiceBusy ? '生成中…' : state === 'none' ? '生成配音' : '重新生成'}
      </Button>
    </div>
  )
}
