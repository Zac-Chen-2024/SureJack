import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { AmbientBackdrop } from '../components/AmbientBackdrop'

/** 停留多久。做成有分量的开屏——不是一闪而过，也不至于让人等 */
const DWELL_MS = 1500
/** 丝滑的缓动：easeOutQuint，尾巴收得很缓，不生硬 */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * 登录后的专属欢迎开屏。问候语由后端按姓名给（config/welcome.json，
 * 如「欢迎主人 / 欢迎老大」）。
 *
 * 这是这个 App 的"开屏"——所以做成一段有分量的动画：品牌标记先浮现、
 * 问候语跟上、一条强调色线展开收尾，停留一会儿再淡出进工作台。全程无需
 * 点击（这一页没有任何决策，多一次点击只是白等）。品牌标记用产品自己的
 * 意象（竖屏画幅 + 底部字幕条），不是那只兔子。
 */
export function WelcomePage ({ onEnter }: { onEnter: () => void }) {
  const { welcome } = useSession()
  const [shown, setShown] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const t1 = setTimeout(() => setShown(true), 90)
    const t2 = setTimeout(() => setLeaving(true), 90 + DWELL_MS)
    const t3 = setTimeout(onEnter, 90 + DWELL_MS + 460)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onEnter])

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
        {/* 品牌标记：竖屏画幅 + 琥珀字幕条。先浮现（缓缓放大+淡入） */}
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

        {/* 问候语：从虚到实（blur→清晰）+ 上浮 */}
        <div
          className="text-center text-[40px] font-semibold leading-tight tracking-[-0.02em] text-ink-50"
          style={{
            transition: `opacity 680ms ${EASE}, transform 680ms ${EASE}, filter 680ms ${EASE}`,
            transitionDelay: '150ms',
            opacity: shown ? 1 : 0,
            transform: shown ? 'translateY(0)' : 'translateY(14px)',
            filter: shown ? 'blur(0px)' : 'blur(10px)',
          }}
        >
          {welcome ?? '欢迎回来'}
        </div>

        {/* 强调色线：最后从中间展开收尾 */}
        <div
          className="mt-5 h-0.5 rounded-full bg-accent"
          style={{
            transition: `width 760ms ${EASE}, opacity 760ms ${EASE}`,
            transitionDelay: '380ms', width: shown ? 76 : 0, opacity: shown ? 1 : 0,
          }}
        />
      </div>
    </div>
  )
}
