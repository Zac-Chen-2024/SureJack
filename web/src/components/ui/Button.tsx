import type { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

/**
 * 克制的按钮：主色只在 primary 出现，其余靠灰阶和字重。
 * hover 提亮一档、active 轻微下沉，让点击有感知反馈而不是死板的色块切换；
 * 过渡与键盘 focus 光环由 index.css 全局兜底。
 */
export function Button ({ variant = 'ghost', className = '', ...rest }: Props) {
  // gap-2 只在按钮同时有图标+文字时起作用（单一子元素时是 no-op）——
  // 图标是界面的语法，和文字并排必须垂直居中、间距统一，不是各写各的
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg border border-transparent px-4 py-2 text-sm font-medium active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:active:translate-y-0'
  const styles = {
    // 琥珀金背景亮度高，压深色字才够对比度——不是沿用旧版的白字
    // 禁用态用中性灰阶，不是把强调色调暗——调暗的 accent 会显脏
    primary: 'bg-accent font-semibold text-ink-950 hover:bg-accent-dim disabled:bg-ink-800 disabled:font-medium disabled:text-ink-400 disabled:hover:bg-ink-800',
    ghost: 'text-ink-300 hover:border-line hover:bg-ink-850 hover:text-ink-50 disabled:text-ink-400 disabled:hover:border-transparent disabled:hover:bg-transparent',
    danger: 'text-danger hover:bg-danger/10 disabled:text-ink-400 disabled:hover:bg-transparent',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}
