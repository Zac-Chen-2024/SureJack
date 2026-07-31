import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/**
 * 「手一按，界面让路」的滑块（手机端字幕高度 / 字号用）。
 *
 * ── 为什么不用普通滑块 ──────────────────────────────────────────────
 * 用户在调的是"字幕在画面上什么样"，而那条滑块所在的抽屉正好盖着半个画面。
 * 于是他只能：拖一下 → 关抽屉 → 看 → 再打开 → 再拖。判断和操作被隔开了，
 * 每一轮都要重新找感觉。
 *
 * 这里反过来：**手指一按，界面整个淡掉，只剩画面和那行字幕**；拖的时候
 * 看着画面实时变；松手界面回来。判断和操作合到了同一个动作里。
 *
 * ── 只认左右 ────────────────────────────────────────────────────────
 * 按下之后手指去哪儿都行，只有【横向位移】改数值。不用再盯着一条 4px 高的
 * 轨道——那条轨道在这套交互里已经不是操作对象了，它只是个起手的地方。
 * 纵向一律忽略：手在屏幕上横滑很难走直线，认纵向只会让数值乱跳。
 *
 * ── 灵敏度 ──────────────────────────────────────────────────────────
 * 横滑整屏 ≈ 半个量程。太灵敏会抖，太钝要来回搓好几趟。
 */

/** 谁正在被拖。界面据此淡出——放全局是因为要淡的是抽屉和底栏，不在这个组件里 */
interface ScrubState {
  active: string | null
  label: string
  begin: (id: string) => void
  update: (label: string) => void
  end: () => void
}

export const useScrub = create<ScrubState>((set) => ({
  active: null,
  label: '',
  begin: (id) => set({ active: id }),
  update: (label) => set({ label }),
  end: () => set({ active: null, label: '' }),
}))

const SWEEP = 0.5   // 横滑整屏 = 半个量程

export function ScrubSlider ({
  id, label, value, min, max, step, format, onChange, onCommit,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  /** 拖动时浮在画面上的读数。不给就显示数字本身 */
  format?: (v: number) => string
  onChange: (v: number) => void
  /** 【松手即确认】。用户要的就是这个：拖完就生效，不用再点一次 */
  onCommit: () => void
}) {
  const scrub = useScrub()
  const start = useRef<{ x: number; v: number } | null>(null)
  const [live, setLive] = useState(value)

  // 外部改了值（比如取消草稿）时跟上
  useEffect(() => { if (start.current === null) setLive(value) }, [value])

  const clamp = (v: number): number => {
    const snapped = Math.round(v / step) * step
    return Math.min(max, Math.max(min, snapped))
  }

  function onDown (e: React.PointerEvent<HTMLDivElement>) {
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    start.current = { x: e.clientX, v: live }
    scrub.begin(id)
    scrub.update(format ? format(live) : String(live))
  }

  function onMove (e: React.PointerEvent<HTMLDivElement>) {
    const s = start.current
    if (!s) return
    // 【只看横向】。纵向一律忽略——手在屏幕上横滑很难走直线
    const dx = e.clientX - s.x
    const perPx = ((max - min) * SWEEP) / Math.max(1, window.innerWidth)
    const next = clamp(s.v + dx * perPx)
    if (next !== live) {
      setLive(next)
      onChange(next)
    }
    scrub.update(format ? format(next) : String(next))
  }

  function onUp () {
    if (start.current === null) return
    start.current = null
    scrub.end()
    /*
     * 【松手就是确认】。用户明确要这个：拖完立刻生效，不用再点一次。
     *
     * 但只在【值真的变了】时才提交：这一下会触发重烧十几分钟，
     * 手指碰一下没挪动不该让一条好好的片子作废。
     */
    if (live !== value) onCommit()
  }

  const pct = ((live - min) / Math.max(1, max - min)) * 100

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      // 按住之后要横向滑动，不能让浏览器把它当成滚动手势抢走
      style={{ touchAction: 'none' }}
      className="select-none py-2"
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={live}
      tabIndex={0}
    >
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-ink-400">
        <span>{label}</span>
        <span className="tabular-nums text-ink-200">{format ? format(live) : live}</span>
      </div>
      {/* 轨道只是"起手的地方"，所以做得比原来厚一点，好按 */}
      <div className="relative h-2 rounded-full bg-ink-700">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow"
          style={{ left: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-ink-600">按住左右滑——界面会让开，直接看画面</p>
    </div>
  )
}

/**
 * 拖动时浮在画面正中的读数。
 *
 * 界面都淡掉了，不给个数字的话用户不知道自己调到哪儿了——他能看见效果，
 * 但记不住"刚才那个好看的是多少"。
 */
export function ScrubReadout () {
  const { active, label } = useScrub()
  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
      <span className="rounded-2xl bg-black/55 px-5 py-2.5 text-2xl font-extrabold tabular-nums text-white backdrop-blur-sm">
        {label}
      </span>
    </div>
  )
}
