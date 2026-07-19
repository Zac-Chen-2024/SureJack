import { useEffect, useState } from 'react'

/**
 * 全屏氛围背景：**用问候语平铺成斜向纹理**。
 *
 * ── 为什么用 SVG pattern 而不是旋转一堆 div ────────────────────────
 * 第一版是"铺 N 行文字 + CSS transform 旋转整块"。那样必须自己算清楚
 * 块要多大才盖得住旋转后的视口——算错就留死角，而且这个死角随视口
 * 尺寸变化，改一次数字只能修一个分辨率。实测右下角就是这么空掉的，
 * 把行数从 40 提到 120 仍然有缺口。
 *
 * 换成 pattern 之后覆盖是**构造上保证**的：把旋转烘进 patternTransform，
 * 浏览器按 tile 无限平铺，不存在"够不够大"这个问题。
 *
 * ── 为什么压到几乎看不见 ────────────────────────────────────────────
 * 这是背景不是内容。右边那栏正在写字，余光里任何跳动的东西都是干扰。
 * 3.2% 的白：扫过去觉得"这块有质地"，盯着看才分辨出是字。
 *
 * ⚠️ 【透明度和底色是绑定的】底色从 #08080a 抬到 #12151b 之后，同样的
 * 白叠加【反而更显眼】——alpha 合成在编码后的 sRGB 空间里进行，亮底上
 * 的增量更大。实测沿用 4.5% 会让 ΔL* 从 3.71 冲到 5.42。改底色时
 * 必须回头重算这个值，不然会静默走样。
 */

/** 6:00–18:00 算白天。这个界线不必精确——它只决定一句问候语。 */
function greetingFor (hour: number): string {
  return hour >= 6 && hour < 18
    ? 'Good Noon And Good Work'
    : 'Good Night And Good Dream'
}

/** 斜纹倾角。-24° 比 45° 更斜、更"织物"，正 45° 容易读成装饰边框 */
const ANGLE = -24

/** 单个 tile 的尺寸（px）。要放得下一整句 + 间隔，否则会看出接缝 */
const TILE_W = 460
const TILE_H = 88

function tileUrl (text: string): string {
  /*
   * 手写 SVG 而不是用 <pattern>：Chrome 对 background-image 里的 SVG
   * 有独立的渲染路径，pattern + patternTransform 在某些缩放下会出现
   * 半像素接缝。直接把整个 tile 画成一张已经倾斜的图，靠 background-repeat
   * 平铺，接缝问题不存在。
   *
   * 文字画两行、第二行横向错开半个 tile：不错开的话所有行的起点会
   * 连成一条竖线，一眼看出是"贴上去的"而不是织出来的。
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">
<g transform="rotate(${ANGLE} ${TILE_W / 2} ${TILE_H / 2})">
<text x="-200" y="26" fill="rgba(255,255,255,0.032)" font-family="system-ui,sans-serif" font-size="13" font-weight="500" letter-spacing="4.6" text-transform="uppercase">${text}</text>
<text x="30" y="70" fill="rgba(255,255,255,0.032)" font-family="system-ui,sans-serif" font-size="13" font-weight="500" letter-spacing="4.6">${text}</text>
</g></svg>`
  /*
   * encodeURIComponent 而不是塞原始 SVG：# 和 " 在 data URI 里会截断。
   * 【前一轮设计代理踩过一个相关的坑】：把 url("data:image/svg+xml,…")
   * 写进 HTML 的 style【属性字符串】时，内层双引号会提前闭合属性——
   * 无报错、无警告，getComputedStyle 返回 url("")，看起来就像"纹理太淡"。
   * 这里走 React 的 style 对象（经 CSSOM 赋值）不受那个坑影响，
   * 但 URI 编码仍然必须做。
   */
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
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
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{
        backgroundImage: tileUrl(greeting.toUpperCase()),
        backgroundRepeat: 'repeat',
        backgroundSize: `${TILE_W}px ${TILE_H}px`,
      }}
    />
  )
}
