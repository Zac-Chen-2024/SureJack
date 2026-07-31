import { useEffect, useMemo, useState } from 'react'

/**
 * 字幕尺子（/subtitle-lab）——量一组"字号 + 高度"出来。
 *
 * ── 它的全部价值在于"量得准" ────────────────────────────────────────
 * 一个和成片长得不一样的预览，量出来的数字是废的。所以这一页做了三件
 * 别处没做的事：
 *
 * 1【用同一副字】。烧录用的是 Noto Sans CJK SC Bold。这里把它子集化成
 *   265KB 的 webfont（只装用户文案里真出现过的 1731 个字符）当场加载，
 *   而不是让设备拿自己的黑体去凑——苹方和思源的字面宽度差得出来。
 *
 * 2【换算 libass 的字号】。ASS 里填的 Fontsize【不是】渲染出来的像素高。
 *   实测三个字号（48/64/96），每字实际宽度稳定在 Fontsize 的 **0.686** 倍。
 *   浏览器里方块字的步进正好是 1em，所以 CSS 字号 = ASS 字号 × 0.686。
 *   不换算的话预览会比成片大将近一半，量出来的数字全部偏小。
 *
 * 3【底图用素材库里真实的一帧】。纯色底上什么字号都清楚，而字幕会不会糊，
 *   糊的正是地铁跑酷那种高光和杂色多的画面。
 *
 * ── 一次性 ──────────────────────────────────────────────────────────
 * 不接项目、不改默认值。提交只是把两个数字记到服务器的一行日志里。
 */

/** 成片坐标系。ASS 的 PlayRes 就是它，所有参数都以它为单位 */
const PLAY_W = 1080
const PLAY_H = 1920

/**
 * libass 的 Fontsize → 实际每字宽度的比例。实测值，别改成 1。
 * 48→32.9px、64→43.9px、96→65.8px，三点都落在 0.685±0.001。
 */
const LIBASS_SCALE = 0.686

/**
 * 垂直基线补正。**也是量出来的。**
 *
 * MarginV 在 libass 那边是从画面底到【文字底】的距离，实测填 300 时
 * 墨迹底边落在 308；而 CSS 的 bottom 定的是行盒底边，方块字会略微溢出行盒，
 * 加上 4px 描边，墨迹底边反而跑到 295。两边差 13（字号 64 时），
 * 不补的话预览里的字比成片低一截——而"会不会压到脸"恰恰就差这一截。
 *
 * 13/64 ≈ 0.203，随字号线性缩放。
 */
const BASELINE_FIX = 0.203

/** 和 ass.ts 的 Style: Sub 保持一致 */
const OUTLINE = 4                      // 描边宽度（成片坐标系）
const COLOR_SUNG = '#FFE500'           // PrimaryColour &H0000E5FF（BGR）→ 已读
const COLOR_UNSUNG = '#FFFFFF'         // SecondaryColour → 未读
const SIDE_MARGIN = 60                 // MarginL / MarginR

const MIN_FONT = 36
const MAX_FONT = 120
/*
 * 【尺子不设产品里那道钳位】。产品里 maxSubtitleMarginV 把字幕限制在画面
 * 下半部分（半屏），那是个产品判断；而尺子的用途正是"看看放到别处会怎样"，
 * 带着结论去量等于白量。
 *
 * 上限按字号动态算：字幕顶边贴到画面最上沿为止（再往上就出画了）。
 * 下限 0 = 底边贴着画面最下沿。合起来就是从顶到底。
 */
const MIN_MARGIN = 0
/**
 * 一行字从"MarginV 那条线"往上占多高，占字号的比例。上限 = 画面高 − 它×字号。
 *
 * 【按行盒算，不是按墨迹算】。先按墨迹高 0.67 减，拉到头字顶还是被切了
 * ——因为 CSS 里占位的是行盒（line-height 1.15 × 0.686 ≈ 0.79 字号），
 * 再加上基线补正的 0.20，合起来正好约等于【一个字号】。
 *
 * 实测三个字号（36/64/120）在 1920−1.0×字号 处，字块顶边刚好贴住画面顶。
 */
const TOP_ROOM = 1.0

const SAMPLE = '座右铭从人淡如菊改成大力出奇迹'

export function SubtitleLab () {
  const [fontSize, setFontSize] = useState(64)
  const [marginV, setMarginV] = useState(300)
  const [text, setText] = useState(SAMPLE)
  const [frame, setFrame] = useState(0)
  const [frames, setFrames] = useState<{ i: number; label: string }[]>([])
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    fetch('/api/subtitle-lab/frames')
      .then((r) => r.json())
      .then((d: { frames: { i: number; label: string }[] }) => setFrames(d.frames))
      .catch(() => { /* 底图列表拿不到就只用第 0 张，不影响量尺子 */ })
  }, [])

  /*
   * 预览画面的宽度。整页按"成片坐标系 → 预览像素"缩放，所有尺寸都乘这个数，
   * 于是滑块上的数字始终是【成片里的数字】，而不是某个屏幕上的数字。
   */
  const [previewW, setPreviewW] = useState(360)
  useEffect(() => {
    const fit = (): void => {
      // 竖屏 9:16，高度不超过视口的 72%，宽度不超过 420
      const byH = (window.innerHeight * 0.72) * (PLAY_W / PLAY_H)
      setPreviewW(Math.max(240, Math.min(420, byH, window.innerWidth - 32)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const k = previewW / PLAY_W          // 成片坐标 → 预览像素
  const cssFont = fontSize * LIBASS_SCALE * k
  // 顶到底：上限 = 画面高 - 这一行字的墨迹高，再高字就出画了
  const maxMargin = Math.round(PLAY_H - fontSize * TOP_ROOM)

  // 卡拉OK扫光：前 45% 已读（琥珀），后面未读（白）。取个中间态最有代表性
  const chars = useMemo(() => [...text], [text])
  const sungCount = Math.round(chars.length * 0.45)

  async function submit () {
    setBusy(true)
    try {
      await fetch('/api/subtitle-lab/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fontSize, marginV, frame, note }),
      })
      setSent(true)
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-full bg-ink-950 px-4 pb-10 pt-5 text-ink-100">
      {/* 这一页自带字体，不动全局样式 */}
      <style>{`
        @font-face {
          font-family: 'SJ Burn';
          src: url('/fonts/sub-sc-bold.woff2') format('woff2');
          font-weight: 700;
          font-display: swap;
        }
      `}</style>

      <div className="mx-auto flex max-w-[480px] flex-col items-center gap-4">
        <div className="w-full">
          <h1 className="text-xl font-extrabold text-ink-50">字幕尺子</h1>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            这里的字体、描边、颜色和成片里烧上去的完全一样，字号也按 libass
            的实际渲染比例换算过。调到你觉得舒服，提交给我。
          </p>
        </div>

        {/* ── 模拟画面 ─────────────────────────────────────────────── */}
        <div
          className="relative shrink-0 overflow-hidden rounded-xl bg-ink-900 shadow-2xl shadow-black/60"
          style={{ width: previewW, height: previewW * (PLAY_H / PLAY_W) }}
        >
          <img
            src={`/api/subtitle-lab/frame/${frame}.jpg`}
            alt=""
            className="absolute inset-0 size-full object-cover"
          />

          {/* 字幕。底边距 = marginV，两侧留白 = MarginL/R，都按成片坐标缩放 */}
          <div
            className="absolute text-center"
            style={{
              left: SIDE_MARGIN * k,
              right: SIDE_MARGIN * k,
              // 加补正：让预览的墨迹底边落在和成片同一条线上（见 BASELINE_FIX）
              bottom: (marginV + fontSize * BASELINE_FIX) * k,
              fontFamily: "'SJ Burn', sans-serif",
              fontWeight: 700,
              fontSize: cssFont,
              lineHeight: 1.15,
              /*
               * 【不折行】。实测 libass 在中文长行超出边距时是【直接溢出】，
               * 不像浏览器那样自动折——中文没有词边界，它找不到折点。
               * 让浏览器也不折，字太大时就该看到它顶出画面，那正是这把尺子
               * 要告诉你的事：这个字号在这条画面上放不下。
               */
              whiteSpace: 'nowrap',
              // 描边同样跟着画面缩放（ASS 里 ScaledBorderAndShadow: yes）
              WebkitTextStroke: `${OUTLINE * k}px #000`,
              paintOrder: 'stroke fill',
            }}
          >
            {chars.map((c, i) => (
              <span key={i} style={{ color: i < sungCount ? COLOR_SUNG : COLOR_UNSUNG }}>{c}</span>
            ))}
          </div>

          {/* 底边基准线：让"离底多远"变成看得见的东西 */}
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-white/25"
            style={{ bottom: marginV * k }}
          />
        </div>

        {/* ── 控件 ────────────────────────────────────────────────── */}
        <div className="w-full space-y-4">
          {frames.length > 1 && (
            <div className="flex gap-1.5">
              {frames.map((f) => (
                <button
                  key={f.i} type="button" onClick={() => setFrame(f.i)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    frame === f.i ? 'bg-ink-700 text-ink-50' : 'bg-ink-850 text-ink-400'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <label className="block">
            <span className="mb-1.5 flex items-baseline justify-between">
              <span className="text-xs font-bold text-ink-100">字号</span>
              <span className="text-xs tabular-nums text-accent">{fontSize}</span>
            </span>
            <input
              type="range" min={MIN_FONT} max={MAX_FONT} step={1}
              value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-full" style={{ accentColor: 'var(--color-accent)' }}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 flex items-baseline justify-between">
              <span className="text-xs font-bold text-ink-100">离画面底部</span>
              <span className="text-xs tabular-nums text-accent">
                {marginV}<span className="ml-1 text-ink-500">/ {maxMargin}</span>
              </span>
            </span>
            <input
              type="range" min={MIN_MARGIN} max={maxMargin} step={5}
              value={Math.min(marginV, maxMargin)}
              onChange={(e) => setMarginV(Number(e.target.value))}
              className="w-full" style={{ accentColor: 'var(--color-accent)' }}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold text-ink-100">换句话试试</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-ink-50 outline-none"
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              字太大或句子太长时会顶出画面——和成片里的行为一致（libass 对
              中文长行是直接溢出，不折行）。看到溢出就说明这个字号偏大。
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold text-ink-100">备注（可留空）</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="比如：这个高度在 iPhone 上刚好躲开底部横条"
              className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
            />
          </label>

          {/* ── 结果 ──────────────────────────────────────────────── */}
          <div className="rounded-xl border border-line bg-ink-900 p-3">
            <div className="flex items-baseline gap-4 tabular-nums">
              <span className="text-[11px] text-ink-400">字号</span>
              <span className="text-lg font-extrabold text-ink-50">{fontSize}</span>
              <span className="text-[11px] text-ink-400">高度</span>
              <span className="text-lg font-extrabold text-ink-50">{marginV}</span>
            </div>
          </div>

          <button
            type="button"
            disabled={busy || sent}
            onClick={() => void submit()}
            className="w-full rounded-xl bg-accent py-3.5 text-sm font-extrabold text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? '提交中…' : sent ? '已提交' : '提交这组参数'}
          </button>
        </div>
      </div>

      {/* 提交后的回执 */}
      {sent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-8">
          <div className="w-full max-w-[320px] rounded-2xl border border-line bg-ink-900 p-6 text-center">
            <p className="text-base font-extrabold text-ink-50">已严肃收集</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              字号 <b className="text-accent">{fontSize}</b>、
              离底 <b className="text-accent">{marginV}</b>，记下了。
            </p>
            <button
              type="button"
              onClick={() => setSent(false)}
              className="mt-4 w-full rounded-xl border border-line py-2.5 text-sm font-medium text-ink-200"
            >
              再调一组
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
