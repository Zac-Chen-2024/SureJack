import { useProjects } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { IconChevronLeft, IconLoader, IconCheck } from '../ui/Icon'

/**
 * 生成中蒙层（成片还没出来、但流程在跑时的编辑器主视图）。
 *
 * 点了「生成」就该看到它：配音生成中 → 视频合成中 X%，两步进度一目了然。
 * 顶栏留返回——可以回列表继续建别的项目，进度在列表上也看得到；活儿在
 * 后台跑，不占着这个页面。
 */
export function MobileGenerating ({ onBack, projectName }: { onBack: () => void; projectName: string }) {
  const ttsState = useProjects((s) => s.current()?.ttsState ?? 'none')
  const filmState = usePipeline((s) => s.film?.state ?? null)
  const progress = usePipeline((s) => s.film?.progress ?? 0)

  const voiceReady = ttsState === 'ready'
  const composing = filmState === 'building'
  const errored = ttsState === 'error' || filmState === 'error'

  return (
    <div className="absolute inset-0 bg-ink-950">
      {/* 顶栏：返回列表 */}
      <div className="absolute inset-x-0 z-10 flex px-4" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}>
        <button
          type="button" onClick={onBack}
          className="flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-3.5 py-2 text-sm font-semibold text-ink-100"
        >
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
          <span className="max-w-[46vw] truncate">{projectName}</span>
        </button>
      </div>

      <div className="flex h-full flex-col items-center justify-center px-8">
        {errored ? (
          <div className="text-center">
            <p className="text-base font-semibold text-danger">生成失败了</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              网络或服务可能出了点问题。回到列表，进这个项目的「配音」重试一次即可。
            </p>
          </div>
        ) : (
          <div className="w-full max-w-[300px]">
            <p className="mb-6 text-center text-base font-bold text-ink-50">正在生成你的视频</p>
            <Step
              n={1} title="配音生成"
              state={voiceReady ? 'done' : 'active'}
              hint={voiceReady ? '已完成' : '正在用 AI 合成配音…'}
            />
            <div className="ml-[15px] h-5 w-px bg-line" />
            <Step
              n={2} title="视频合成"
              state={composing ? 'active' : voiceReady ? 'active' : 'wait'}
              hint={composing ? undefined : voiceReady ? '排队中…' : '等配音好了自动开始'}
              percent={composing ? progress : undefined}
            />
            <p className="mt-7 text-center text-[11px] leading-relaxed text-ink-500">
              合成要几分钟。可以返回列表继续建别的项目，进度在列表上也看得到；好了这里会自动出现成片。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Step ({ n, title, state, hint, percent }: {
  n: number; title: string; state: 'done' | 'active' | 'wait'; hint?: string; percent?: number
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border ${
          state === 'done' ? 'border-accent bg-accent/15 text-accent'
            : state === 'active' ? 'border-accent text-accent'
              : 'border-line text-ink-600'
        }`}
      >
        {state === 'done' ? <IconCheck className="size-4" />
          : state === 'active' ? <IconLoader className="size-4 animate-spin" />
            : <span className="text-xs font-bold tabular-nums">{n}</span>}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-baseline justify-between">
          <span className={`text-sm font-semibold ${state === 'wait' ? 'text-ink-500' : 'text-ink-100'}`}>{title}</span>
          {percent !== undefined && <span className="text-sm font-bold tabular-nums text-accent">{percent}%</span>}
        </div>
        {percent !== undefined ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${percent}%` }} />
          </div>
        ) : hint ? (
          <p className="mt-0.5 text-[11px] text-ink-400">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}
