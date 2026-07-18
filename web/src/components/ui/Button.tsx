import type { ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

/** 克制的按钮：主色只在 primary 出现，其余靠灰阶和字重 */
export function Button ({ variant = 'ghost', className = '', ...rest }: Props) {
  const base = 'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-dim',
    ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-50',
    danger: 'text-danger hover:bg-danger/10',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}
