import { useEffect, useState } from 'react'

/**
 * 工作台两侧留白的氛围背景：**用问候语本身平铺成斜向纹理**。
 *
 * ── 纹理是文字，不是线条 ────────────────────────────────────────────
 * 第一版画的是真的斜线 + 两行竖排字，那是两件东西拼在一起。
 * 现在整片纹理就是同一句话反复排开——远看是有肌理的斜纹，
 * 凑近才看清写的是什么。这种"读得出但不打扰"的分寸正是留白该有的。
 *
 * ── 为什么要压到几乎看不见 ──────────────────────────────────────────
 * 这是背景不是内容。右边那栏正在写字，任何在余光里跳动的东西都是干扰。
 * 所以亮度只有 3.5%：扫过去觉得"这块有质地"，盯着看才分辨出是字。
 * 字距拉到 0.35em 也是同一个目的——拉散之后单词不成团，
 * 更像织物的纹路而不是一句要读的话。
 */

/** 6:00–18:00 算白天。这个界线不必精确——它只决定一句问候语。 */
function greetingFor (hour: number): string {
  return hour >= 6 && hour < 18
    ? 'Good Noon And Good Work'
    : 'Good Night And Good Dream'
}

/** 斜纹倾角。-24° 比 45° 更斜、更"织物"，正 45° 容易读成装饰边框 */
const ANGLE = -24

/** 铺多少行。旋转后要盖住整个视口的对角线，行数要给足 */
const ROWS = 40

/** 每行重复多少遍。同样是宁多勿少，多出来的部分被 overflow 裁掉 */
const REPEATS = 12

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

  // 单行内容：重复若干遍，中间用间隔符断开，避免读成一长串
  const line = Array.from({ length: REPEATS }, () => greeting).join('   ·   ')

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/*
        旋转容器开到 200% 并往左上各偏 50%：旋转之后四个角会露出来，
        不开大就会在角落看到纹理的边界，那一下就露馅了。
      */}
      <div
        className="absolute"
        style={{
          top: '-50%', left: '-50%', width: '200%', height: '200%',
          transform: `rotate(${ANGLE}deg)`,
        }}
      >
        {Array.from({ length: ROWS }, (_, i) => (
          <div
            key={i}
            className="select-none whitespace-nowrap font-medium uppercase"
            style={{
              fontSize: '13px',
              lineHeight: '2.6',
              letterSpacing: '0.35em',
              color: 'rgba(255,255,255,0.035)',
              // 每隔一行错开半个身位，避免所有行的起点连成一条竖线
              paddingLeft: i % 2 === 0 ? 0 : '7rem',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}
