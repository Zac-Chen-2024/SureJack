import type { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

/** 克制的按钮：主色只在 primary 出现，其余靠灰阶和字重 */
export function Button ({ variant = 'ghost', className = '', ...rest }: Props) {
  const base = 'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed'
  const styles = {
    // 禁用态用中性灰阶，不是把强调色调暗——调暗的 accent 会显脏
    primary: 'bg-accent text-white hover:bg-accent-dim disabled:bg-ink-800 disabled:text-ink-400 disabled:hover:bg-ink-800',
    ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-50 disabled:text-ink-400 disabled:hover:bg-transparent disabled:hover:text-ink-400',
    danger: 'text-danger hover:bg-danger/10 disabled:text-ink-400 disabled:hover:bg-transparent',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}
