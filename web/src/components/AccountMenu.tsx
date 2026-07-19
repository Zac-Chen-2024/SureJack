import { useEffect, useRef, useState } from 'react'
import { useSession } from '../store/session'
import { Avatar } from './ui/Avatar'
import { IconLogOut } from './ui/Icon'
import { PALETTES, PALETTE_LABELS, currentPalette, setPalette, type Palette } from '../palette'

/**
 * 账户菜单：一个头像，点开才有登出。
 *
 * 【为什么不做成常驻的登出按钮】登出是一年用不了几次的动作，却在
 * 每一屏里占着一整行、还带个图标——它的视觉分量和使用频率完全不匹配。
 * 收进头像之后，那一行还给了真正常看的东西，而"我是谁"仍然一眼可见。
 */
export function AccountMenu () {
  const { name, logout } = useSession()
  const [open, setOpen] = useState(false)
  // 以 <html> 上的属性为准：那是页面真正在用的那一套（见 palette.ts）
  const [palette, setPaletteState] = useState<Palette>(() => currentPalette())
  const boxRef = useRef<HTMLDivElement>(null)

  /*
   * 点外面收起。用 mousedown 而不是 click：click 要等按下+松开都完成，
   * 用户按住拖选文字再松手也会触发，菜单会莫名其妙地关掉。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      {/*
        触发器【只有头像】，不带名字那一行。名字对本人来说是零信息量——
        这是单人登录的工具，屏幕前的人当然知道自己是谁；写出来只是在
        每一屏里占一行。要确认身份时 hover 有 title，点开菜单里也写着。
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg ring-line hover:ring-2"
        title={`${name} —— 点击查看账户选项`}
      >
        <Avatar name={name ?? ''} />
      </button>

      {open && (
        /*
         * 向【上】展开：这个菜单在栏底，向下会掉出视口。
         * 触发器只有一个头像那么宽，菜单不能跟着那么窄——用 left-0 从
         * 头像左边缘起、min-w 给足，让「登出」有正常的点击面积。
         */
        <div className="absolute bottom-full left-0 z-30 mb-1 min-w-36 overflow-hidden rounded-lg border border-line bg-ink-850 py-1 shadow-2xl shadow-black/60">
          <div className="truncate border-b border-line px-3 pb-1.5 pt-1 text-xs text-ink-400">{name}</div>

          {/*
            配色切换。做成一排小胶囊而不是下拉：只有两个选项，
            下拉要点两次才能换，胶囊一次就够，而且当前是哪套一眼可见。
          */}
          <div className="border-b border-line px-3 py-2">
            <div className="mb-1.5 text-[11px] text-ink-400">配色</div>
            <div className="flex gap-1">
              {PALETTES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => { setPalette(p); setPaletteState(p) }}
                  className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
                    palette === p
                      ? 'bg-accent text-ink-950'
                      : 'border border-line text-ink-300 hover:text-ink-50'
                  }`}
                >
                  {PALETTE_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); logout() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-50"
          >
            <IconLogOut className="size-4" /> 登出
          </button>
        </div>
      )}
    </div>
  )
}
