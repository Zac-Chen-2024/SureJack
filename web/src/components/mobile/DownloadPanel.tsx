import { useCallback, useEffect, useRef, useState } from 'react'
import { IconDownload, IconCheck, IconClose, IconTrash, IconLoader } from '../ui/Icon'
import { useDownloads } from '../../store/downloads'

/**
 * 下载队列悬浮框（项目列表页，账户头像旁边）。
 *
 * 数据来自【原生桥】：安卓壳用自己的前台服务下载（断点续传、通知栏进度），
 * 再通过 SJNative.downloads() 把进度吐回网页，这样在 App 里也看得见，
 * 不用去翻通知栏。
 *
 * ⚠️ 曾经用的是系统 DownloadManager，但它【一次都没工作过】——服务器日志里
 * AndroidDownloadManager 这个 UA 从来没出现过，下载实际是 WebView 在拉，
 * 而 WebView 不会续传，480MB 传几 MB 就断。现在由 App 自己下。
 *
 * 普通浏览器里没有这个桥 → 整个入口不显示（浏览器自己有下载管理器，
 * 我们再画一个只是重复）。
 *
 * 版式上刻意【不做"盒子里套盒子"】：每条只用一条分隔线隔开，进度条压在
 * 文件名下面。嵌套卡片在 280px 宽的悬浮框里会把内容挤成一团——那正是
 * 上一版看着乱的原因。
 */
/**
 * ⚠️【身份是 projectId，不是下载 id】。原来用时间戳当 id，于是每次点下载
 * 都是一条新记录：进程被杀重投 + 从磁盘恢复 = 同一条片子出现两条，
 * 而且每杀一次进程多攒一条幽灵。换成 projectId 之后天然唯一。
 */
interface NativeDownload {
  projectId: string; title: string; total: number; done: number
  /**
   * running（在传）| reconnecting（断了，自动重连中）| paused（用户按了暂停）
   * | done | error
   *
   * ⚠️【reconnecting 和 paused 必须分开显示】。它们原来共用一个 paused，
   * 界面只能写一句含糊的"已暂停"——用户以为要自己点一下才继续，
   * 实际上几秒后它自己就重连了；真暂停时他又干等。用户就是这么被误导的。
   */
  status: string
  /** 当前速度，字节/秒。老版本 App 没有这个字段 */
  bps?: number
  /** status=failed 时的原因。**必须显示**——不然用户只能反复撞同一堵墙 */
  error?: string
}

interface Bridge {
  downloads: () => string
  /** 中断/删除一条下载，连文件一起删。老版本 App 没有这个方法 → 不画按钮 */
  removeDownload?: (projectId: string) => boolean
  /** 暂停/继续。通知栏上有同样的按钮，两处是同一个开关 */
  pauseDownload?: (projectId: string, pause: boolean) => boolean
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

/**
 * @param floating 悬浮版：固定在右上角，给【列表页以外】的所有屏幕用。
 *
 * ⚠️【不管在哪儿点下载，都得在 App 里看得见进度】。原来这个组件只挂在
 * "我的项目"列表页的标题栏里，而用户是在【成片页】点的下载——那一屏
 * 根本没画这个东西，于是通知栏有进度、App 里一片空白，
 * 用户以为没下上又去点一次。
 */
export function DownloadPanel ({ floating = false }: { floating?: boolean } = {}) {
  const prep = useDownloads((s) => s.preparing)
  const dismiss = useDownloads((s) => s.dismiss)
  const [items, setItems] = useState<NativeDownload[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const bridge = typeof window !== 'undefined' ? readBridge() : null
  const canRemove = typeof bridge?.removeDownload === 'function'
  const canPause = typeof bridge?.pauseDownload === 'function'

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
    try { bridge?.removeDownload?.(d.projectId) } catch { /* 删不掉就让下面的刷新说话 */ }
    // 先本地摘掉，别等下一轮轮询——点了没反应最让人怀疑是不是没点上
    setItems((list) => list.filter((x) => x.projectId !== d.projectId))
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
  /*
   * ⚠️【备货中的那一段也算下载任务】。成片是下载那一刻现混的，混完才交给
   * 原生下载器——在那之前这条任务只活在网页里。不把它算进来的话，用户点完
   * 下载打开队列看到的是"还没有下载任务"，等于告诉他没点上。
   */
  const preparing = Object.values(prep)
  if (!bridge && preparing.length === 0) return null
  const running = items.filter((d) =>
    d.status === 'running' || d.status === 'paused' || d.status === 'reconnecting')
  // 交接中也算"在忙"——否则角标会在交接那一秒归零，看着像下载没了
  const busy = running.length
    + preparing.filter((p) => p.phase === 'mixing' || p.phase === 'handoff').length

  // 悬浮版在闲着的时候完全不出现，免得挡住每一屏的右上角
  if (floating && busy === 0) return null

  return (
    <div
      ref={ref}
      className={floating
        ? 'fixed right-3 z-40'
        : 'relative'}
      style={floating
        ? { top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }
        : undefined}
    >
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
              {busy > 0 ? `${busy} 个进行中` : items.length > 0 ? `${items.length} 条记录` : ''}
            </span>
            <button
              type="button" aria-label="关闭"
              onClick={() => setOpen(false)}
              className="-mr-1 flex size-6 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              <IconClose className="size-3.5" />
            </button>
          </div>

          {/* 备货中的排在最上面：它们是刚点的，用户最想看到的就是这几条 */}
          {preparing.length > 0 && (
            <div className="border-b border-line">
              {preparing.map((p) => (
                <div key={p.projectId} className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink-100">{p.name}</p>
                    <p className={`text-[11px] ${p.phase === 'error' ? 'text-danger' : 'text-ink-400'}`}>
                      {p.phase === 'error'
                        ? (p.error ?? '合成失败')
                        : p.phase === 'handoff' ? '准备下载…' : '合成中…'}
                    </p>
                  </div>
                  {p.phase === 'error'
                    ? (
                      <button
                        type="button" aria-label="移除"
                        onClick={() => dismiss(p.projectId)}
                        className="flex size-6 items-center justify-center rounded-lg text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                      >
                        <IconClose className="size-3.5" />
                      </button>
                    )
                    : <IconLoader className="size-4 animate-spin text-accent" />}
                </div>
              ))}
            </div>
          )}

          {items.length === 0 && preparing.length === 0 ? (
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
                const failed = d.status === 'failed'
                return (
                  <div key={d.projectId} className="border-b border-line px-3.5 py-2.5 last:border-b-0">
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

                      {/*
                        * 【暂停 / 继续】。通知栏上有同样的一对按钮，两处是同一个开关。
                        * 尤其重要的是「继续」：App 被系统回收之后，下载记录是从
                        * 磁盘读回来的，状态一律是"已暂停"——没有这个按钮，
                        * 那条已经下了一半的片子就再也接不上了。
                        */}
                      {canPause && !done && !failed && (
                        <button
                          type="button"
                          aria-label={d.status === 'paused' ? '继续下载' : '暂停下载'}
                          title={d.status === 'paused' ? '继续下载' : '暂停下载'}
                          onClick={() => {
                            bridge?.pauseDownload?.(d.projectId, d.status !== 'paused')
                            setTimeout(refresh, 200)
                          }}
                          className="flex size-6 shrink-0 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-50"
                        >
                          <span className="text-[13px] leading-none">
                            {d.status === 'paused' ? '▶' : '⏸'}
                          </span>
                        </button>
                      )}

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

                    {/*
                      * 【失败必须说清原因】。"成片已过期，请重新点一次下载"
                      * 和"登录过期，请重新打开 App"是两种完全不同的处置，
                      * 而上一版这两种都会在重启后伪装成一个带「继续」按钮的
                      * 暂停项——用户点一次撞一次墙，原因早就不见了。
                      */}
                    {failed && d.error != null && d.error !== '' && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-danger">{d.error}</p>
                    )}

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
                          {/*
                            * 【不能写"已暂停"】。paused 是我们自己在【断线之后、
                            * 下一次重试之前】打的标记，不是用户按了暂停。
                            * 写"已暂停"会让用户以为要自己点一下才会继续，
                            * 实际上它几秒后就自己接着传了——她就是这么被误导的。
                            */}
                          {d.status === 'reconnecting' && ' · 断线了，正在自动重连'}
                          {d.status === 'paused' && ' · 已暂停'}
                          {d.status === 'running' && (d.bps ?? 0) > 0
                            && ` · ${d.bps! >= 1048576
                              ? `${(d.bps! / 1048576).toFixed(1)} MB/s`
                              : `${Math.round(d.bps! / 1024)} KB/s`}`}
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
