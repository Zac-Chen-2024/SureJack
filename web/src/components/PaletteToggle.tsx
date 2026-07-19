import { useState } from 'react'
import { currentPalette, setPalette } from '../palette'
import { IconCoffee, IconIce } from './ui/Icon'

/**
 * 配色开关：咖啡（暖）↔ 冰块（冷）。
 *
 * ── 为什么显示的是【要切过去的那个】而不是当前的 ──────────────────
 * 这是个只有两态的开关，图标同时兼着"现在是什么"和"点了会变成什么"
 * 两个职责，必须挑一个。挑后者：开关的意义在于它能带你去哪儿，
 * 而"现在是暖是冷"看一眼整个界面就知道了，不需要一个 16px 的图标复述。
 *
 * 所以暖调时显示冰块（点它变冷），冷调时显示咖啡（点它变暖）。
 * title 里把这件事写明白，免得有人对着图标猜。
 */
export function PaletteToggle () {
  const [palette, setLocal] = useState(currentPalette)
  const next = palette === 'warm' ? 'precise' : 'warm'
  const label = next === 'warm' ? '换成暖色' : '换成冷色'

  return (
    <button
      type="button"
      onClick={() => { setPalette(next); setLocal(next) }}
      title={label}
      aria-label={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-850 hover:text-accent"
    >
      {next === 'warm'
        ? <IconCoffee className="size-4" />
        : <IconIce className="size-4" />}
    </button>
  )
}
