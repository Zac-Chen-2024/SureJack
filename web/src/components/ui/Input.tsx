import type { InputHTMLAttributes } from 'react'

export function Input ({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-ink-700 bg-ink-800 px-3.5 py-2.5 text-sm text-ink-50 placeholder:text-ink-400 outline-none transition-colors focus:border-accent ${className}`}
      {...rest}
    />
  )
}
