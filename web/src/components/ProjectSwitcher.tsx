import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../store/projects'
import { IconChevronDown, IconPlus, IconTrash } from './ui/Icon'

/**
 * 项目切换器：当前项目名 + 点击向下展开的项目列表。
 *
 * ── 为什么它取代了整整一栏 ──────────────────────────────────────────
 * 原来项目列表自成一栏（180px 通栏），但它只干两件事：显示"我在哪个
 * 项目"、偶尔换一个。前者只需要一行字，后者一年用不了几次——
 * 为此常驻一栏，等于让最不常用的操作占掉最贵的横向空间。
 *
 * 收进这个下拉之后：当前项目名仍然常驻可见（那是必要的定位信息），
 * 而"列出所有项目"这个低频动作只在点击时才占空间。
 */
export function ProjectSwitcher () {
  const { items, currentId, select, create, remove } = useProjects()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const current = items.find((p) => p.id === currentId)

  /*
   * 点外面收起。用 mousedown 而不是 click：click 要等按下+松开都完成，
   * 用户按住拖选文字再松手也会触发，弹层会莫名其妙地关掉。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
        setAdding(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Esc 关闭：弹层类元素不给键盘出口是很烦人的
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setAdding(false) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function submit () {
    const v = name.trim()
    if (!v) return
    await create(v)
    setName('')
    setAdding(false)
    setOpen(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-14 w-full items-center gap-1.5 border-b border-line px-4 text-left text-sm font-medium text-ink-100 hover:bg-ink-850"
        title="切换项目"
      >
        <span className="min-w-0 flex-1 truncate">{current?.name ?? '选一个项目'}</span>
        <IconChevronDown
          className={`size-4 shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        /*
         * 向下展开，绝对定位浮在内容之上。
         *
         * z-20：预览那栏的 canvas 和这个弹层不在同一个层叠上下文里，
         * 不给足够高的 z 值会被画面盖住一半。
         */
        <div className="absolute inset-x-0 top-full z-20 max-h-[60vh] overflow-y-auto border-b border-line bg-ink-850 py-1 shadow-2xl shadow-black/60">
          {adding ? (
            <div className="px-3 py-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                  if (e.key === 'Escape') { setAdding(false); setName('') }
                }}
                placeholder="项目名"
                className="w-full rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-sm text-ink-50 outline-none placeholder:text-ink-400"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-50"
            >
              <IconPlus className="size-3.5" /> 新建项目
            </button>
          )}

          <div className="my-1 border-t border-line" />

          {items.length === 0 && (
            <p className="px-4 py-2 text-xs text-ink-400">还没有项目</p>
          )}

          {items.map((p) => (
            <div
              key={p.id}
              className={`group flex cursor-pointer items-center gap-2 px-4 py-2 text-sm hover:bg-ink-800 ${
                p.id === currentId ? 'bg-ink-800 text-ink-50' : 'text-ink-300'
              }`}
              onClick={() => { select(p.id); setOpen(false) }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault(); select(p.id); setOpen(false)
                }
              }}
            >
              {/* 选中态用一条琥珀竖条而不是整行染色——整行染太抢 */}
              <span
                className={`h-4 w-0.5 shrink-0 rounded-full ${
                  p.id === currentId ? 'bg-accent' : 'bg-transparent'
                }`}
              />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="shrink-0 tabular-nums text-[11px] text-ink-600">
                {[...(p.scriptText ?? '')].length} 字
              </span>
              <button
                type="button"
                aria-label={`删除 ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`删除「${p.name}」？`)) remove(p.id)
                }}
                className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconTrash className="size-3.5 text-ink-400 hover:text-danger" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
