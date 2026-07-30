import { useEffect, useState } from 'react'
import { IconDownload } from '../ui/Icon'

/**
 * 下载队列悬浮框（项目列表页，账户头像旁边）。
 *
 * 数据来自【原生桥】：安卓壳把下载交给系统 DownloadManager（断网续传、
 * 通知栏进度都免费得到），再通过 SJNative.downloads() 把进度吐回网页，
 * 这样在 App 里也看得见，不用去翻通知栏。
 *
 * 普通浏览器里没有这个桥 → 整个入口不显示（浏览器自己有下载管理器，
 * 我们再画一个只是重复）。
 */
interface NativeDownload { title: string; total: number; done: number; status: string }

interface Bridge { downloads: () => string }

function readBridge (): Bridge | null {
  const w = window as unknown as { SJNative?: Bridge }
  return typeof w.SJNative?.downloads === 'function' ? w.SJNative : null
}

export function DownloadPanel () {
  const [items, setItems] = useState<NativeDownload[]>([])
  const [open, setOpen] = useState(false)
  const bridge = typeof window !== 'undefined' ? readBridge() : null

  useEffect(() => {
    if (!bridge) return
    const tick = () => {
      try {
        const raw = bridge.downloads()
        const list = JSON.parse(raw) as NativeDownload[]
        setItems(Array.isArray(list) ? list : [])
      } catch { /* 桥出问题就当没有下载，不打扰 */ }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [bridge])

  if (!bridge || items.length === 0) return null
  const running = items.filter((d) => d.status === 'running' || d.status === 'paused')

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="下载队列"
        onClick={() => setOpen((v) => !v)}
        className="relative flex size-9 items-center justify-center rounded-lg text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50"
      >
        <IconDownload className="size-4" />
        {running.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-ink-950">
            {running.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-ink-850 p-2 shadow-2xl shadow-black/60">
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-ink-500">下载</div>
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {items.map((d, i) => {
              const pct = d.total > 0 ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0
              return (
                <div key={`${d.title}-${i}`} className="rounded-lg bg-ink-900 px-2.5 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-100">{d.title}</span>
                    <span className={`shrink-0 text-[11px] tabular-nums ${
                      d.status === 'done' ? 'text-accent' : d.status === 'error' ? 'text-danger' : 'text-ink-400'
                    }`}
                    >
                      {d.status === 'done' ? '完成' : d.status === 'error' ? '失败' : `${pct}%`}
                    </span>
                  </div>
                  {d.status !== 'done' && d.status !== 'error' && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
                      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className="mt-2 px-1 text-[10px] leading-relaxed text-ink-600">
            视频存到手机的「下载」目录，文件名就是项目名。
          </p>
        </div>
      )}
    </div>
  )
}
