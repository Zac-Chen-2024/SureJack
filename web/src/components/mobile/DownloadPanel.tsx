import { useCallback, useEffect, useRef, useState } from 'react'
import { IconDownload, IconCheck, IconClose, IconTrash } from '../ui/Icon'

/**
 * 下载队列悬浮框（项目列表页，账户头像旁边）。
 *
 * 数据来自【原生桥】：安卓壳把下载交给系统 DownloadManager（断网续传、
 * 通知栏进度都免费得到），再通过 SJNative.downloads() 把进度吐回网页，
 * 这样在 App 里也看得见，不用去翻通知栏。
 *
 * 普通浏览器里没有这个桥 → 整个入口不显示（浏览器自己有下载管理器，
 * 我们再画一个只是重复）。
 *
 * 版式上刻意【不做"盒子里套盒子"】：每条只用一条分隔线隔开，进度条压在
 * 文件名下面。嵌套卡片在 280px 宽的悬浮框里会把内容挤成一团——那正是
 * 上一版看着乱的原因。
 */
interface NativeDownload { id: number; title: string; total: number; done: number; status: string }

interface Bridge {
  downloads: () => string
  /** 中断/删除一条下载，连文件一起删。老版本 App 没有这个方法 → 不画按钮 */
  removeDownload?: (id: string) => boolean
}

function readBridge (): Bridge | null {
  const w = window as unknown as { SJNative?: Bridge }
  return typeof w.SJNative?.downloads === 'function' ? w.SJNative : null
}

/** 字节数说人话。成片都在几十 MB 量级，一位小数够用 */
function mb (bytes: number): string {
  if (bytes <= 0) return '—'
  const m = bytes / 1024 / 1024
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${m.toFixed(1)} MB`
}

export function DownloadPanel () {
  const [items, setItems] = useState<NativeDownload[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const bridge = typeof window !== 'undefined' ? readBridge() : null
  const canRemove = typeof bridge?.removeDownload === 'function'

  const refresh = useCallback(() => {
    if (!bridge) return
    try {
      const raw = bridge.downloads()
      const list = JSON.parse(raw) as NativeDownload[]
      setItems(Array.isArray(list) ? list : [])
    } catch { /* 桥出问题就当没有下载，不打扰 */ }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    refresh()
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
  }, [bridge, refresh])

  /*
   * 中断 = 停掉正在下的（半截文件由系统一并清掉）；
   * 删除 = 连手机里那个视频文件一起删。两件事在 DownloadManager 那边是同一个
   * 动作（remove），但对用户是两种意图，所以问法不同、图标不同。
   */
  function remove (d: NativeDownload, kind: 'cancel' | 'delete') {
    const q = kind === 'cancel'
      ? `中断下载「${d.title}」？已经下的部分会被丢掉。`
      : `删除「${d.title}」？手机里的这个视频文件也会一起删掉。`
    if (!confirm(q)) return
    try { bridge?.removeDownload?.(String(d.id)) } catch { /* 删不掉就让下面的刷新说话 */ }
    // 先本地摘掉，别等下一轮轮询——点了没反应最让人怀疑是不是没点上
    setItems((list) => list.filter((x) => x.id !== d.id))
    refresh()
  }

  // 点外面收起来——悬浮框挡着列表，必须能一下关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  /*
   * 【只以"有没有桥"决定显不显示】。原来还要求 items 非空，结果新装的 App
   * 因为一次都没下载过 → 入口整个不出现 → 用户以为功能没做。
   * 浏览器里没有桥才隐藏（浏览器自带下载管理器，我们再画一个只是重复）。
   */
  if (!bridge) return null
  const running = items.filter((d) => d.status === 'running' || d.status === 'paused')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="下载队列"
        onClick={() => setOpen((v) => !v)}
        className={`relative flex size-9 items-center justify-center rounded-lg transition-colors ${
          open ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-50'
        }`}
      >
        <IconDownload className="size-4" />
        {running.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-ink-950">
            {running.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="sj-motion absolute right-0 top-full z-30 mt-2 w-[17.5rem] origin-top-right overflow-hidden rounded-2xl border border-line-strong bg-ink-850 shadow-2xl shadow-black/70"
          style={{ animation: 'sj-pop 180ms cubic-bezier(0.22,1,0.36,1) both' }}
        >
          {/* 标题条：左边写是什么，右边写现在忙不忙 */}
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span className="text-[13px] font-bold text-ink-50">下载</span>
            <span className="ml-auto text-[11px] tabular-nums text-ink-400">
              {running.length > 0 ? `${running.length} 个进行中` : items.length > 0 ? `${items.length} 条记录` : ''}
            </span>
            <button
              type="button" aria-label="关闭"
              onClick={() => setOpen(false)}
              className="-mr-1 flex size-6 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              <IconClose className="size-3.5" />
            </button>
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
              <IconDownload className="size-5 text-ink-600" />
              <p className="text-xs text-ink-400">还没有下载任务</p>
              <p className="text-[11px] leading-relaxed text-ink-600">
                在预览页点「下载成片」，进度会显示在这里
              </p>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {items.map((d) => {
                const pct = d.total > 0 ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0
                const done = d.status === 'done'
                const failed = d.status === 'error'
                return (
                  <div key={d.id} className="border-b border-line px-3.5 py-2.5 last:border-b-0">
                    <div className="flex items-center gap-2">
                      {done && <IconCheck className="size-3.5 shrink-0 text-accent" />}
                      <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'text-ink-300' : 'text-ink-50'}`}>
                        {d.title}
                      </span>
                      <span className={`shrink-0 text-[11px] font-medium tabular-nums ${
                        done ? 'text-accent' : failed ? 'text-danger' : 'text-ink-300'
                      }`}
                      >
                        {done ? '已保存' : failed ? '失败' : `${pct}%`}
                      </span>

                      {/* 老版本 App 的桥没有 removeDownload → 不画按钮，
                          不给一个点下去什么都不会发生的东西 */}
                      {canRemove && (
                        <button
                          type="button"
                          aria-label={done || failed ? '删除' : '中断下载'}
                          title={done || failed ? '删除（连同手机里的文件）' : '中断下载'}
                          onClick={() => remove(d, done || failed ? 'delete' : 'cancel')}
                          className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-danger"
                        >
                          {done || failed ? <IconTrash className="size-3.5" /> : <IconClose className="size-3.5" />}
                        </button>
                      )}
                    </div>

                    {!done && !failed && (
                      <>
                        <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-ink-800">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${pct}%`, transition: 'width 600ms cubic-bezier(0.22,1,0.36,1)' }}
                          />
                        </div>
                        <div className="mt-1.5 text-[10px] tabular-nums text-ink-600">
                          {mb(d.done)} / {mb(d.total)}
                          {d.status === 'paused' && ' · 已暂停'}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="border-t border-line px-3.5 py-2 text-[10px] leading-relaxed text-ink-600">
            存到手机的「下载」目录，文件名就是项目名
          </p>
        </div>
      )}
    </div>
  )
}
