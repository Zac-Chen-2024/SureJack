import type { SelectHTMLAttributes } from 'react'

/**
 * 下拉选择。样式和 Input 对齐——同一个表单里两种输入长得不一样，
 * 会让人以为它们的行为也不一样。
 *
 * appearance-none + 自绘箭头：各浏览器的原生箭头长得都不同，
 * 而这个界面别处已经没有任何浅色控件了，留着原生样式会格外显眼。
 */
export function Select ({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative min-w-0 flex-1 ${className}`}>
      <select
        {...rest}
        className="w-full appearance-none rounded-lg border border-line bg-ink-800 py-2.5 pl-3.5 pr-8 text-sm text-ink-50 outline-none focus:border-accent"
      >
        {children}
      </select>
      <svg
        aria-hidden="true" viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  )
}
