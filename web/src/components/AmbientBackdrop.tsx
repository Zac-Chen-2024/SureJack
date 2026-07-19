import { useEffect, useState } from 'react'

/**
 * 工作台两侧留白的氛围背景：细斜纹 + 随时间变化的问候语。
 *
 * ── 为什么斜纹要这么淡 ──────────────────────────────────────────────
 * 这是留白，不是内容区。纹理的作用是让空白"有质地"而不是一片死黑，
 * 一旦看得清就成了干扰——眼睛会被拉过去，而右边那栏还在写字。
 * 所以线宽 1px、间距 8px、亮度 2.5%：扫一眼觉得"这里有东西"，
 * 盯着看才分辨得出是斜纹。
 *
 * ── 为什么问候语是竖排的 ────────────────────────────────────────────
 * 留白是两条窄长条（1920 屏上每边约 360px 宽、整屏高）。横排文字在这种
 * 比例里要么被截断要么小得像噪点；竖排顺着长边走，字距拉开之后
 * 读起来像装帧上的书脊，正好是"留白但不空"的分寸。
 */

/** 6:00–18:00 算白天。这个界线不必精确——它只决定一句问候语。 */
function greetingFor (hour: number): string {
  return hour >= 6 && hour < 18
    ? 'Good Noon And Good Work'
    : 'Good Night And Good Dream'
}

export function AmbientBackdrop () {
  const [greeting, setGreeting] = useState(() => greetingFor(new Date().getHours()))

  /*
   * 跨越昼夜分界时要换。每分钟对一次时——不用 setTimeout 精确算到
   * 下一个整点：用户很可能就在 17:59 打开着页面，而一个每分钟跑一次的
   * 纯计算便宜到可以忽略，比算跨时区/夏令时的下一个触发时刻可靠得多。
   */
  useEffect(() => {
    const t = setInterval(() => setGreeting(greetingFor(new Date().getHours())), 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 细斜纹。用 repeating-linear-gradient 而不是贴图：零请求、任意分辨率都清晰 */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg,' +
            'rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px,' +
            'transparent 1px, transparent 8px)',
        }}
      />
      {/* 两侧各一行竖排问候语，贴着工作台外缘 */}
      {(['left', 'right'] as const).map((side) => (
        <div
          key={side}
          className="absolute inset-y-0 flex items-center"
          style={{ [side]: '2.5rem' } as React.CSSProperties}
        >
          <span
            className="select-none whitespace-nowrap text-[11px] uppercase text-ink-600/70"
            style={{
              writingMode: 'vertical-rl',
              // 左侧那行转 180°，让两边的字都朝向画面中心，读起来是对称的
              transform: side === 'left' ? 'rotate(180deg)' : undefined,
              letterSpacing: '0.42em',
            }}
          >
            {greeting}
          </span>
        </div>
      ))}
    </div>
  )
}
