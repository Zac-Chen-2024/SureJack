import { useEffect, useState } from 'react'

/**
 * 是不是手机屏。
 *
 * 用 matchMedia 而不是只读一次 innerWidth：转屏、分屏、桌面缩窗口都要跟着变，
 * 否则一进来判成桌面就锁死了。阈值 640px：再宽三栏还塞得下，再窄就得换布局。
 */
export function useIsMobile (): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}
