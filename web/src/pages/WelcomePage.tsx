import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../store/session'
import { AmbientBackdrop } from '../components/AmbientBackdrop'

/** 停留基准。留出摇一摇的时间；不摇则到点淡出 */
const DWELL_MS = 2200
/** 丝滑缓动 */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** 从问候语里取称呼（欢迎主人→主人，欢迎老大→老大，兜底老大） */
function honorificOf (welcome: string | null): string {
  if (welcome?.includes('主人')) return '主人'
  if (welcome?.includes('老大')) return '老大'
  return '老大'
}

/** 摇一摇检测（安卓 TWA 直接可用，无需授权）。加速度突变超阈值触发一次。 */
function useShake (onShake: () => void): void {
  useEffect(() => {
    let lx = 0, ly = 0, lz = 0, lastT = 0, primed = false
    const onMotion = (e: DeviceMotionEvent): void => {
      const a = e.accelerationIncludingGravity
      if (!a) return
      const now = Date.now()
      if (now - lastT < 90) return
      const dt = now - lastT || 1
      lastT = now
      const x = a.x ?? 0, y = a.y ?? 0, z = a.z ?? 0
      const dx = x - lx, dy = y - ly, dz = z - lz
      lx = x; ly = y; lz = z
      if (!primed) { primed = true; return }
      if ((Math.sqrt(dx * dx + dy * dy + dz * dz) / dt) * 1000 > 900) onShake()
    }
    window.addEventListener('devicemotion', onMotion)
    return () => window.removeEventListener('devicemotion', onMotion)
  }, [onShake])
}

/**
 * 登录后的专属欢迎开屏。**极简**：深色背景先在，问候语（欢迎主人/欢迎老大，
 * 来自 config/welcome.json）纯淡入缓缓浮现——只动透明度，不做 blur（blur
 * 动画在手机上很卡，是之前"不丝滑"的主因）。屏上除问候语外没有别的字。
 *
 * 隐藏彩蛋：不小心摇到手机 → 换成「{称呼}辛苦了！/ 我来帮您做视频！」并
 * 多停一会儿。不写任何"摇一摇"提示，摇到才有。
 */
export function WelcomePage ({ onEnter }: { onEnter: () => void }) {
  const { welcome } = useSession()
  const [shown, setShown] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [shaken, setShaken] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const honorific = honorificOf(welcome)

  const schedule = useCallback((dwell: number) => {
    timers.current.forEach(clearTimeout)
    timers.current = [
      setTimeout(() => setLeaving(true), dwell),
      setTimeout(onEnter, dwell + 520),
    ]
  }, [onEnter])

  useEffect(() => {
    // 背景先在，稍等一下文字再缓缓浮现
    const t = setTimeout(() => setShown(true), 300)
    schedule(300 + DWELL_MS)
    return () => { clearTimeout(t); timers.current.forEach(clearTimeout) }
  }, [schedule])

  const onShake = useCallback(() => {
    setShaken((prev) => { if (prev) return prev; schedule(2100); return true })
  }, [schedule])
  useShake(onShake)

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-8">
      <AmbientBackdrop />
      <div
        key={shaken ? 'shake' : 'hi'}
        className={`relative whitespace-pre-line text-center text-[34px] font-semibold leading-snug tracking-[-0.01em] text-ink-50 ${shaken ? 'sj-wobble' : ''}`}
        style={{
          transition: `opacity 1100ms ${EASE}, transform 1100ms ${EASE}`,
          opacity: leaving ? 0 : shown ? 1 : 0,
          transform: shown && !leaving ? 'translateY(0)' : 'translateY(10px)',
        }}
      >
        {shaken ? `${honorific}辛苦了！\n我来帮您做视频！` : (welcome ?? '欢迎回来')}
      </div>
    </div>
  )
}
