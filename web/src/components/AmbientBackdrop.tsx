import { useEffect, useState } from 'react'

/**
 * 全屏氛围背景：**用问候语平铺成斜向纹理**。
 *
 * ── 为什么是旋转的文字行，而不是 SVG 平铺 ──────────────────────────
 * 试过用 SVG tile + background-repeat：覆盖确实是构造上保证的，但每个
 * tile 里的文字被切断在 tile 边界，平铺后能看出规律的重复接缝，
 * 读起来像贴图而不是织物。文字行的做法自然得多——一行就是完整的一句，
 * 长短、间隔都连续。
 *
 * ── 覆盖靠把容器开得足够大 ──────────────────────────────────────────
 * 旋转 -24° 之后，要盖住视口就得让未旋转的块比视口大不少。之前用
 * 200%、偏移 -50% 时右下角是空的：块的左边缘旋转后往上抬，
 * 左下和右下就露了出来。
 *
 * 现在 300% + 偏移 -100%：块的中心仍在视口中心，但四个方向各多出
 * 一整个视口的余量，任何倾角下都盖得住。行数按块高算足，不留空档。
 *
 * ── 为什么压到几乎看不见 ────────────────────────────────────────────
 * 这是背景不是内容。右边那栏正在写字，余光里任何跳动的东西都是干扰。
 *
 * ⚠️ 【透明度和底色是绑定的】底色从 #08080a 抬到 #12151b 之后，同样的
 * 白叠加【反而更显眼】——alpha 合成在编码后的 sRGB 空间里进行，亮底上
 * 的增量更大。实测沿用 4.5% 会让 ΔL* 从 3.71 冲到 5.42，降到 3.2%
 * 才回到 3.58。改底色时必须回头重算这个值。
 */

/** 6:00–18:00 算白天。这个界线不必精确——它只决定一句问候语。 */
function greetingFor (hour: number): string {
  return hour >= 6 && hour < 18
    ? 'Good Noon And Good Work'
    : 'Good Night And Good Dream'
}

/** 斜纹倾角。-24° 比 45° 更斜、更"织物"，正 45° 容易读成装饰边框 */
const ANGLE = -24

/** 每行重复多少遍。宁多勿少，多出来的被 overflow 裁掉 */
const REPEATS = 20

/**
 * 铺多少行。
 *
 * 容器高 300vh；行高 13px × 2.6 ≈ 33.8px。要填满 2000px 高屏幕的 300%
 * （6000px）需要约 178 行。取 220 留足余量——文字节点很便宜，
 * 宁可多铺也不要再出现空角。
 */
const ROWS = 220

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

  const line = Array.from({ length: REPEATS }, () => greeting).join('   ·   ')

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="absolute"
        style={{
          // 300% + 偏移 -100%：中心对齐视口中心，四周各留一个视口的余量
          top: '-100%', left: '-100%', width: '300%', height: '300%',
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
              color: 'rgba(255,255,255,0.032)',
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
