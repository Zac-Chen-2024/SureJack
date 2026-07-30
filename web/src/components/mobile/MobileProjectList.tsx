import { useEffect, useRef, useState } from 'react'
import { useProjects, type Project } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { AccountMenu } from '../AccountMenu'
import { PaletteToggle } from '../PaletteToggle'
import { DownloadPanel } from './DownloadPanel'
import { IconPlus, IconLoader, IconTrash, IconMore } from '../ui/Icon'

/**
 * 手机版项目列表（概念图 Screen 0）：**我的项目 + 一步新建**。
 *
 * 每条一行：竖着的缩略图占位（成片是 9:16，用竖条呼应）+ 名字 + 一句摘要
 * + 右侧状态徽标（草稿 / 合成中 / 已完成）。状态是这屏的信息核心——它让
 * 用户不点进去就知道每个项目卡在哪一步。
 *
 * 桌面用的是顶部的项目切换下拉；手机屏够高，直接铺成一整屏列表更好扫。
 */

/** 项目此刻处在哪一步。合成进度来自列表轮询（filmProgress） */
type Status = 'draft' | 'voicing' | 'render' | 'done'

function statusOf (p: Project, composing: boolean): Status {
  if (composing) return 'render'
  if (p.ttsState === 'generating') return 'voicing'
  if (p.ttsState === 'ready') return 'done'
  return 'draft'
}

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'text-accent bg-accent/12' },
  // 两个"进行中"阶段共用琥珀（语义色，独立于冷/暖主题），靠标签区分；
  // 强调色留给"完成"。
  voicing: { label: '配音中', cls: 'text-[#e0a82e] bg-[#e0a82e]/12' },
  render: { label: '合成中', cls: 'text-[#e0a82e] bg-[#e0a82e]/12' },
  draft: { label: '草稿', cls: 'text-ink-300 bg-ink-800' },
}

/** 一句摘要：文案开头 + 时长/状态。不堆细节，够一眼判断即可 */
function summaryOf (p: Project): string {
  const head = (p.scriptText ?? '').trim().replace(/\s+/g, '')
  const secs = p.ttsDurationMs ? Math.round(p.ttsDurationMs / 1000) : null
  const dur = secs !== null ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : null
  if (p.ttsState === 'ready') {
    const byo = p.subtitleMode === 'line' ? '自备配音' : '配音已生成'
    return [head ? head.slice(0, 12) : byo, dur].filter(Boolean).join(' · ')
  }
  if (head) return `仅文案 · 未配音`
  return '空项目 · 从这里开始'
}

export function MobileProjectList ({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const items = useProjects((s) => s.items)
  const remove = useProjects((s) => s.remove)
  const reload = useProjects((s) => s.load)
  const filmProgress = usePipeline((s) => s.filmProgress)

  /*
   * 【下拉刷新】。列表本来每 5 秒自动刷，但用户想"立刻知道现在怎么样了"时
   * 需要一个自己能触发的动作——干等着刷新是最让人不安的状态。
   * 只在已经滚到最顶(scrollTop<=0)时起手，否则会和正常的向下滚动打架。
   */
  const scrollRef = useRef<HTMLDivElement>(null)
  const pullStart = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  async function doRefresh () {
    setRefreshing(true)
    try { await reload() } finally {
      setRefreshing(false)
      setPull(0)
    }
  }

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden bg-ink-950"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
    >
      {/* ── 标题栏 ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between px-5 pb-4">
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-50">我的项目</h2>
        <div className="flex items-center gap-1">
          {/* 下载队列：挨着账户头像，点开是进度悬浮框（只在安卓 App 里出现） */}
          <DownloadPanel />
          <PaletteToggle />
          <AccountMenu align="down-right" />
        </div>
      </div>

      {/* 下拉刷新的提示条：跟着手指下拉长出来 */}
      {(pull > 0 || refreshing) && (
        <div
          className="flex shrink-0 items-center justify-center gap-1.5 overflow-hidden text-[11px] text-ink-400 transition-[height]"
          style={{ height: refreshing ? 28 : Math.min(pull, 56) }}
        >
          {refreshing
            ? <><IconLoader className="size-3.5 animate-spin" />正在刷新…</>
            : pull > 48 ? '松手刷新' : '下拉刷新'}
        </div>
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-6"
        onTouchStart={(e) => {
          if ((scrollRef.current?.scrollTop ?? 0) <= 0) pullStart.current = e.touches[0]!.clientY
        }}
        onTouchMove={(e) => {
          if (pullStart.current === null) return
          const d = e.touches[0]!.clientY - pullStart.current
          setPull(d > 0 ? d * 0.5 : 0)
        }}
        onTouchEnd={() => {
          const shouldRefresh = pull > 48
          pullStart.current = null
          if (shouldRefresh) void doRefresh()
          else setPull(0)
        }}
      >
        {/* ── 新建：进引导页（填名+文案→分析人名→确认→生成）─────────── */}
        <button
          type="button"
          onClick={onNew}
          className="mb-5 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-accent py-4 text-[15px] font-extrabold text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconPlus className="size-5" strokeWidth={2.4} />
          新建项目
        </button>

        <div className="mb-3 px-0.5 text-xs font-bold uppercase tracking-wider text-ink-500">最近</div>

        {items.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-ink-400">还没有项目，点上面新建一个。</p>
        ) : (
          <ul className="space-y-3">
            {items.map((p, i) => {
              const composing = filmProgress[p.id]?.composing ?? false
              const st = STATUS_STYLE[statusOf(p, composing)]
              return (
                <li key={p.id}>
                  {/* 行本身是可点的 div（不用 <button>）——里头还要放一个删除按钮，
                      button 套 button 是非法结构 */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(p.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id) } }}
                    className="group flex w-full cursor-pointer items-center gap-3.5 rounded-2xl border border-line bg-ink-900 p-3 text-left transition-colors hover:border-ink-600"
                  >
                    {/* 竖向缩略图占位：两种冷/暖渐变交替，呼应 9:16 画面 */}
                    <span
                      className="relative h-[72px] w-[52px] shrink-0 overflow-hidden rounded-xl"
                      style={{
                        background: i % 2 === 0
                          ? 'linear-gradient(180deg,#122a52,#0f2338)'
                          : 'linear-gradient(180deg,#3a2340,#1a1226)',
                      }}
                    >
                      <span
                        className="absolute bottom-2 left-1/2 h-9 w-5 -translate-x-1/2 rounded-lg"
                        style={{
                          background: i % 2 === 0
                            ? 'linear-gradient(180deg,#ff7a59,#c0392b)'
                            : 'linear-gradient(180deg,#e0a82e,#a06a12)',
                        }}
                      />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-bold text-ink-50">{p.name}</span>
                      <span className="mt-1 block truncate text-xs text-ink-500">
                        {composing
                          ? <span className="inline-flex items-center gap-1 text-[#e0a82e]"><IconLoader className="size-3 animate-spin" />视频合成中 {filmProgress[p.id]?.progress ?? 0}%</span>
                          : p.ttsState === 'generating'
                            ? <span className="inline-flex items-center gap-1 text-[#e0a82e]"><IconLoader className="size-3 animate-spin" />配音生成中…</span>
                            : summaryOf(p)}
                      </span>
                    </span>

                    <span className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold ${st.cls}`}>
                      {st.label}
                    </span>

                    <RowMenu name={p.name} onDelete={() => void remove(p.id)} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * 每行右侧的「⋮」菜单。删除收进这里，不再是那个手机上根本点不着的隐形按钮。
 * 以后加「收藏 / 置顶」直接往菜单里塞一项即可。
 */
function RowMenu ({ name, onDelete }: { name: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button" aria-label="更多" onClick={() => setOpen((v) => !v)}
        className="flex size-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
      >
        <IconMore className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-32 overflow-hidden rounded-xl border border-line bg-ink-850 py-1 shadow-2xl shadow-black/60">
          <button
            type="button"
            onClick={() => { setOpen(false); if (confirm(`删除「${name}」？`)) onDelete() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-300 transition-colors hover:bg-ink-800 hover:text-danger"
          >
            <IconTrash className="size-4" />删除
          </button>
          {/* 以后：收藏 / 置顶 往这儿加 */}
        </div>
      )}
    </div>
  )
}
