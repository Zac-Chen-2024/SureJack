import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../store/session'
import { AmbientBackdrop } from '../components/AmbientBackdrop'

/** 停留基准。做成有分量的开屏，也留出摇一摇的时间 */
const DWELL_MS = 2000
/** 丝滑缓动：easeOutQuint，尾巴收得很缓 */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** 从问候语里取称呼（欢迎主人→主人，欢迎老大→老大，兜底老大） */
function honorificOf (welcome: string | null): string {
  if (welcome?.includes('主人')) return '主人'
  if (welcome?.includes('老大')) return '老大'
  return '老大'
}

/**
 * 摇一摇检测（安卓 TWA 直接可用，无需授权）。加速度突变超阈值即触发一次。
 */
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
      const speed = (Math.sqrt(dx * dx + dy * dy + dz * dz) / dt) * 1000
      if (speed > 900) onShake()
    }
    window.addEventListener('devicemotion', onMotion)
    return () => window.removeEventListener('devicemotion', onMotion)
  }, [onShake])
}

/**
 * 登录后的专属欢迎开屏。问候语由后端按姓名给（config/welcome.json：
 * 欢迎主人 / 欢迎老大）。做成有分量的动画开屏，还能【摇一摇】——摇一下
 * 换成「{称呼}辛苦了！/ 我来帮您做视频！」并抖一下。全程无需点击。
 * 品牌标记用产品自己的意象（竖屏画幅 + 底部字幕条），不是那只兔子。
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
      setTimeout(onEnter, dwell + 460),
    ]
  }, [onEnter])

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 90)
    schedule(90 + DWELL_MS)
    return () => { clearTimeout(t); timers.current.forEach(clearTimeout) }
  }, [schedule])

  const onShake = useCallback(() => {
    setShaken((prev) => {
      if (prev) return prev
      schedule(1900)   // 摇到了：多停一会儿，让人看清那句话
      return true
    })
  }, [schedule])
  useShake(onShake)

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <AmbientBackdrop />
      <div
        className="relative flex flex-col items-center"
        style={{
          transition: `opacity 460ms ${EASE}, transform 460ms ${EASE}`,
          opacity: leaving ? 0 : 1,
          transform: leaving ? 'scale(1.06)' : 'scale(1)',
        }}
      >
        <svg
          viewBox="0 0 32 32" className="mb-6 size-14"
          style={{
            transition: `opacity 640ms ${EASE}, transform 640ms ${EASE}`,
            opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(0.72)',
          }}
        >
          <rect x="9" y="3" width="14" height="26" rx="3" fill="none" stroke="var(--color-accent)" strokeWidth="2.2" />
          <rect x="12" y="21" width="8" height="2.6" rx="1.3" fill="#f0b429" />
        </svg>

        <div
          key={shaken ? 'shake' : 'hi'}
          className={`whitespace-pre-line text-center text-[34px] font-semibold leading-snug tracking-[-0.02em] text-ink-50 ${shaken ? 'sj-wobble' : ''}`}
          style={shaken ? undefined : {
            transition: `opacity 680ms ${EASE}, transform 680ms ${EASE}, filter 680ms ${EASE}`,
            transitionDelay: '150ms',
            opacity: shown ? 1 : 0,
            transform: shown ? 'translateY(0)' : 'translateY(14px)',
            filter: shown ? 'blur(0px)' : 'blur(10px)',
          }}
        >
          {shaken ? `${honorific}辛苦了！\n我来帮您做视频！` : (welcome ?? '欢迎回来')}
        </div>

        <div
          className="mt-5 h-0.5 rounded-full bg-accent"
          style={{
            transition: `width 760ms ${EASE}, opacity 760ms ${EASE}`,
            transitionDelay: '380ms', width: shown ? 76 : 0, opacity: shown ? 1 : 0,
          }}
        />

        {/* 摇一摇提示：摇过就不再显示 */}
        {!shaken && (
          <div
            className="mt-6 text-xs text-ink-500"
            style={{ transition: `opacity 500ms ${EASE}`, transitionDelay: '700ms', opacity: shown ? 1 : 0 }}
          >
            摇一摇手机试试
          </div>
        )}
      </div>
    </div>
  )
}
