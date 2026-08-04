import { useEffect, useState } from 'react'
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
  const projectId = useProjects((s) => s.current()?.id ?? null)
  const cancelFilm = usePipeline((s) => s.cancelFilm)
  const cancel = async () => { if (projectId) await cancelFilm(projectId) }
  // 计时器：配音阶段没有百分比可显示，用已用时表明"确实在跑"
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const retryFilm = usePipeline((s) => s.retryFilm)
  const errCode = usePipeline((s) => s.film?.code ?? null)
  const [busy, setBusy] = useState(false)
  const [retried, setRetried] = useState<string | null>(null)
  const ttsState = useProjects((s) => s.current()?.ttsState ?? 'none')
  const filmState = usePipeline((s) => s.film?.state ?? null)
  const progress = usePipeline((s) => s.film?.progress ?? 0)

  const voiceReady = ttsState === 'ready'
  const composing = filmState === 'building'
  const errored = ttsState === 'error' || filmState === 'error'
  /*
   * 【为什么"很久不动然后突然跳一下"】：成片任务在队列里【排在"拼背景"
   * 任务后面】，排队期间进度恒为 0，轮到它才开始爬。之前统一显示 0% →
   * 看着像卡死。现在 0% 明说"排队中"，真正开始烧才显示百分比，
   * 用户看到的每一步都对得上实际发生的事。
   */
  const queued = composing && progress === 0

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
          /*
           * 【重试不是"回去点生成配音"】。那是把整条链从头再走一遍
           * （10 分钟配音 + 十几分钟烧录），而失败的可能只是最后混一次音。
           * 这个按钮走 /retry，从盘上最远的完好产物接着走。
           *
           * 【错误码要显眼】：用户念得出 E-3f9a21，开发者才 grep 得到；
           * 让他描述"我点了下然后转圈"是没法排查的。
           */
          <div className="w-full max-w-[320px] text-center">
            <p className="text-base font-semibold text-danger">生成失败了</p>
            {errCode !== null && (
              <p className="mt-2 font-mono text-sm font-bold tracking-wider text-ink-100">{errCode}</p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              把上面这个错误码告诉开发人员。也可以先点下面重试一次——
              已经做完的部分不会重来。
            </p>
            {retried !== null && (
              <p className="mt-2 text-[11px] text-accent">{retried}</p>
            )}
            <button
              type="button" disabled={busy}
              onClick={() => {
                if (!projectId) return
                setBusy(true)
                void retryFilm(projectId)
                  .then((r) => {
                    setRetried(r === null
                      ? null
                      : r.queued
                        ? `已从「${r.label}」接着来：${r.next}`
                        : r.next)
                  })
                  .finally(() => setBusy(false))
              }}
              className="sj-motion mt-4 w-full rounded-xl bg-accent px-4 py-3 text-sm font-extrabold text-ink-950 transition-colors disabled:opacity-40"
            >
              {busy ? '正在接着来…' : '接着上次继续'}
            </button>
          </div>
        ) : (
          <div className="w-full max-w-[300px]">
            <p className="mb-6 text-center text-base font-bold text-ink-50">正在生成你的视频</p>
            <Step
              n={1} title="配音生成"
              state={voiceReady ? 'done' : 'active'}
              // Azure 不回进度，用"已用时"代替一个假的百分比——至少是真的在动
              hint={voiceReady ? '已完成' : `正在用 AI 合成配音…已用时 ${elapsed}s`}
            />
            <div className="ml-[15px] h-5 w-px bg-line" />
            <Step
              n={2} title="视频合成"
              state={composing || voiceReady ? 'active' : 'wait'}
              hint={queued ? '排队中，先拼背景…' : composing ? undefined : voiceReady ? '排队中…' : '等配音好了自动开始'}
              percent={composing && !queued ? progress : undefined}
            />
            <p className="mt-7 text-center text-[11px] leading-relaxed text-ink-400">
              合成要几分钟。可以返回列表继续建别的项目，进度在列表上也看得到；好了这里会自动出现成片。
            </p>

            {/* 中断：烧一条要十几分钟，发现搞错了必须能立刻叫停（省 CPU、也不用干等） */}
            <button
              type="button"
              onClick={() => { if (confirm('中断这次生成？已经烧好的部分会作废。')) void cancel() }}
              className="mx-auto mt-4 block rounded-lg border border-line px-4 py-2 text-xs text-ink-400 transition-colors hover:border-danger hover:text-danger"
            >
              中断生成
            </button>
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
          <span className={`text-sm font-semibold ${state === 'wait' ? 'text-ink-400' : 'text-ink-100'}`}>{title}</span>
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
