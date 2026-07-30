import { useRef, useState, type ReactNode } from 'react'

/**
 * 左缘右拖 = 返回上一层。
 *
 * 手势只在【最左侧一条窄带】上起手（不抢中间的点按播放、也不抢竖向滚动），
 * 拖动时整屏跟手右移、左边透出暗层，松手过阈值就 onBack()。
 *
 * 和系统手势的分工：手势导航的安卓机，最边缘被系统留给它自己的返回手势
 * （走 History，我们的 nav 也接住了）；三键导航的机子没有系统边缘手势，
 * 这条窄带就补上了"左滑返回"。两种机型都有左滑可用。
 */
export function SwipeBack ({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  const [dx, setDx] = useState(0)
  const startX = useRef<number | null>(null)

  const width = typeof window !== 'undefined' ? window.innerWidth : 390
  const dragging = startX.current !== null

  function down (e: React.PointerEvent) {
    startX.current = e.clientX
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move (e: React.PointerEvent) {
    if (startX.current === null) return
    setDx(Math.max(0, e.clientX - startX.current))
  }
  function end () {
    if (startX.current === null) return
    const commit = dx > width * 0.33
    startX.current = null
    setDx(0)
    if (commit) onBack()
  }

  return (
    <div
      className="absolute inset-0"
      style={{
        transform: dx > 0 ? `translateX(${dx}px)` : undefined,
        transition: dragging ? 'none' : 'transform 0.22s cubic-bezier(0.32,0.72,0,1)',
      }}
    >
      {children}
      {/* 左缘窄带：手势起手区。拖动时整屏跟着移，左边露出的暗层暗示"退回" */}
      <div
        className="absolute inset-y-0 left-0 z-40 w-6"
        style={{ touchAction: 'none' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      {dx > 0 && <div className="pointer-events-none absolute inset-y-0 z-30 bg-black" style={{ left: -width, width }} />}
    </div>
  )
}
