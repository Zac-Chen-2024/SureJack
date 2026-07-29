import { useEffect, type ReactNode } from 'react'
import { IconChevronDown } from '../ui/Icon'

/**
 * 从底部滑上来的抽屉。手机版所有编辑面板都住在里面。
 *
 * ── 为什么是抽屉 ──────────────────────────────────────────────────
 * 手机上画面(9:16 成片)就该占满屏，是主角。编辑项一次只碰一类——写文案、
 * 调音色、选背景乐——各自从底部滑出、用完即走，主屏始终保持干净。
 *
 * ── 几个必须做对的细节 ────────────────────────────────────────────
 * - 背景遮罩点一下就关：手机上没有"点旁边"这个习惯，遮罩是唯一直觉的退路
 *   （顶上也留一个收起把手兜底）。
 * - 内容区自己滚，抽屉整体不超过 85vh：面板再高也不能顶到状态栏，
 *   上面要露出一截画面，用户知道自己没离开这个项目。
 * - 底部垫 env(safe-area-inset-bottom)：全面屏手机底部有小黑条，
 *   不垫的话按钮会被它压住点不着。
 * - Esc 关：桌面上用大屏调试时也能关，不吃亏。
 */
export function BottomSheet ({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // 抽屉开着时锁住背景滚动，免得手指划过遮罩连带滚了下面的画面
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      {/* 遮罩：点一下关 */}
      <button
        type="button"
        aria-label="收起"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
      />
      {/* 面板 */}
      <div
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border-t border-line bg-ink-900 shadow-2xl shadow-black/70"
        style={{ animation: 'sheet-up 0.22s cubic-bezier(0.32,0.72,0,1)' }}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-sm font-medium text-ink-100">{title}</span>
          <button
            type="button" onClick={onClose} aria-label="收起"
            className="ml-auto flex size-8 items-center justify-center rounded-lg text-ink-400 hover:bg-ink-850 hover:text-ink-100"
          >
            <IconChevronDown className="size-5" />
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-1"
          style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {children}
        </div>
      </div>
      <style>{`@keyframes sheet-up { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>
    </div>
  )
}
