/**
 * 配色切换。两套：`precise`（高对比精密，冷灰 + 信号青）和
 * `warm`（暖调编辑室，棕褐 + 琥珀）。色值本身在 index.css。
 *
 * ── 为什么能这么简单 ────────────────────────────────────────────────
 * 换肤就是在 <html> 上换一个 data-palette 属性。所有组件用的都是
 * Tailwind 工具类（bg-ink-900 之类），而那些类引用的是 CSS 变量，
 * 不是字面色值——所以【没有任何一个组件需要知道换肤这回事】，
 * 也不会有一处漏改。
 *
 * ── 为什么要在渲染前就打上 ──────────────────────────────────────────
 * 见 index.html 里那段内联脚本。React 挂载要等 JS 下载执行完，那之前
 * 页面已经按默认配色画了一帧——用户会看到一次明显的闪色。属性必须
 * 在 <head> 里同步打上，这是唯一能避免闪烁的时机。
 */

export const PALETTES = ['precise', 'warm'] as const
export type Palette = (typeof PALETTES)[number]

/** 界面上给这两套配色的名字。用感觉命名，不用色号 */
export const PALETTE_LABELS: Record<Palette, string> = {
  precise: '冷调',
  warm: '暖调',
}

export const DEFAULT_PALETTE: Palette = 'precise'

const KEY = 'surejack:palette'

function isPalette (v: unknown): v is Palette {
  return typeof v === 'string' && (PALETTES as readonly string[]).includes(v)
}

/**
 * 当前配色。以 <html> 上的属性为准而不是重新读 localStorage——
 * 属性是在 index.html 里就打上的，那才是页面真正在用的那一套。
 */
export function currentPalette (): Palette {
  const attr = document.documentElement.dataset.palette
  return isPalette(attr) ? attr : DEFAULT_PALETTE
}

/** 换一套并记住。⚠️ localStorage 在隐私模式下会抛，不能让它带崩换肤本身 */
export function setPalette (p: Palette): void {
  document.documentElement.dataset.palette = p
  try { localStorage.setItem(KEY, p) } catch { /* 记不住就下次再选 */ }
}
