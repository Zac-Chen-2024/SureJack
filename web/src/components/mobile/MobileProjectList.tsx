import { useEffect, useRef, useState } from 'react'
import { useProjects, type Project } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { AccountMenu } from '../AccountMenu'
import { PaletteToggle } from '../PaletteToggle'
import { IconPlus, IconLoader, IconTrash } from '../ui/Icon'

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
type Status = 'draft' | 'render' | 'done'

function statusOf (p: Project, composing: boolean): Status {
  if (composing) return 'render'
  if (p.ttsState === 'ready') return 'done'
  return 'draft'
}

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'text-accent bg-accent/12' },
  // 琥珀写死成概念图的色值，不跟随冷/暖主题——它是"进行中"的语义色，
  // 和强调色是两回事（强调色留给"完成/可下载"）
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

export function MobileProjectList ({ onOpen }: { onOpen: (id: string) => void }) {
  const { items, create } = useProjects()
  const remove = useProjects((s) => s.remove)
  const filmProgress = usePipeline((s) => s.filmProgress)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  async function submit () {
    const v = name.trim()
    if (!v || busy) return
    setBusy(true)
    try {
      await create(v)
      setName('')
      setAdding(false)
      // create() 已把新项目设为 current，直接进编辑器
      const created = useProjects.getState().currentId
      if (created) onOpen(created)
    } finally {
      setBusy(false)
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
          <PaletteToggle />
          <AccountMenu />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* ── 新建：按钮，点开变成输入行 ─────────────────────────────── */}
        {adding ? (
          <div className="mb-5 flex items-center gap-2 rounded-2xl border border-accent/40 bg-ink-900 p-2">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') { setAdding(false); setName('') }
              }}
              placeholder="项目名"
              className="min-w-0 flex-1 rounded-xl bg-ink-850 px-3 py-2.5 text-[15px] text-ink-50 outline-none placeholder:text-ink-500"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !name.trim()}
              className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-ink-950 disabled:opacity-40"
            >
              {busy ? '创建中' : '创建'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mb-5 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-accent py-4 text-[15px] font-extrabold text-ink-950 transition-colors hover:bg-accent-dim"
          >
            <IconPlus className="size-5" strokeWidth={2.4} />
            新建项目
          </button>
        )}

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
                          ? <span className="inline-flex items-center gap-1 text-accent"><IconLoader className="size-3 animate-spin" />合成中 {filmProgress[p.id]?.progress ?? 0}%</span>
                          : summaryOf(p)}
                      </span>
                    </span>

                    <span className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold ${st.cls}`}>
                      {st.label}
                    </span>

                    <button
                      type="button"
                      aria-label={`删除 ${p.name}`}
                      onClick={(e) => { e.stopPropagation(); if (confirm(`删除「${p.name}」？`)) void remove(p.id) }}
                      className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-600 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    >
                      <IconTrash className="size-4" />
                    </button>
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
