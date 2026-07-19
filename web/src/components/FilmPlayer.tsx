import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { IconPlay, IconPause, IconDownload, IconMore } from './ui/Icon'

/**
 * 成片播放器。**一个 `<video>`，没别的。**
 *
 * ── 它和 Preview 的关系 ──────────────────────────────────────────────
 * Preview 是在【前端现拼】：背景轨、配音、背景音乐三条流各自播放，字幕靠
 * JASSUB 实时渲染到 canvas 上，四层叠出一个"看起来像成片"的东西。那套东西
 * 存在的理由是——当年成片要用户点了导出才有，预览必须先于成片存在。
 *
 * 现在成片在配音就绪时就自动合好了。既然盘上躺着真东西，就没有任何理由
 * 再去拼一个近似品：拼出来的每一处都可能和成片不一样（音量、循环相位、
 * 字幕缩放、A/V 漂移），而这些差异恰恰是最难查的那类 bug——你永远不知道
 * 用户报的"字幕位置不对"是预览错了还是成片错了。
 *
 * 播成片本身，这个问题在结构上就不存在。所以这个组件只有几十行，
 * 而且【绝不该变复杂】：任何"预览要不要也显示 X"的需求，答案都是
 * 让 X 进成片。
 *
 * ── 为什么不用原生 controls ──────────────────────────────────────────
 * 自绘一套是为了和字幕列表联动（onTimeChange 驱动高亮、点某一行跳过去），
 * 而原生控件在这一点上给不了钩子。两套控件同时摆出来则会让人以为
 * 是两个播放器。
 */

interface Props {
  /** 播放头走到哪了。驱动右侧字幕列表的高亮 */
  onTimeChange?: (ms: number) => void
  /** 外部要求跳转。nonce 变化才真跳，所以连点同一行也生效 */
  seek?: { ms: number; nonce: number } | null
}

function fmt (s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export function FilmPlayer ({ onTimeChange, seek }: Props) {
  const project = useProjects((s) => s.current())
  const recomposeFilm = usePipeline((s) => s.recomposeFilm)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  /*
   * 换项目要停下来并回到开头。不重置的话，切过去的一瞬间新片子会从
   * 上一条的播放位置开始——那个位置对新片子毫无意义。
   */
  useEffect(() => {
    setPlaying(false)
    setCur(0)
    setDur(0)
  }, [project?.id])

  // 外部跳转（点字幕某一行）
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!seek || seek.nonce === lastNonce.current) return
    lastNonce.current = seek.nonce
    const v = videoRef.current
    if (v) v.currentTime = seek.ms / 1000
  }, [seek])

  if (!project) return null

  /*
   * 【必须带上 updatedAt】。成片的 URL 是固定的，改完文案重合出来
   * 还是同一个地址——不带一个会变的查询参数，浏览器会把已经缓存的
   * 旧片子接着放，用户改了半天设置看到的画面一动不动。
   */
  const src = `/api/projects/${project.id}/film/stream?v=${encodeURIComponent(project.updatedAt)}`

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { void v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) }
  }

  return (
    /*
     * 【没有标题】。这一栏的列头已经写着"预览"，画面本身也一眼就知道是
     * 什么——再加一行"成片"只是把几十像素的高度从画面上拿走。
     * 竖屏 9:16 里高度是最紧的资源，每一行都要还得起。
     */
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="relative mx-auto w-full max-w-full overflow-hidden rounded-xl border border-line bg-black"
        style={{ aspectRatio: '9 / 16' }}
      >
        <video
          ref={videoRef}
          src={src}
          playsInline
          preload="metadata"
          className="absolute inset-0 size-full object-contain"
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime
            setCur(t)
            onTimeChange?.(Math.round(t * 1000))
          }}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
        />
      </div>

      {/*
        【一整条，内部分块】。
        以前这些分成"播放条"和"成片区"上下两块，各带一行标题——
        两块加起来吃掉一百多像素，说的却是同一件事：这条片子。

        不是几个各自独立的小控件排成一行，而是一根和画面同宽的横条，
        用细分隔线切成几格：播放 | 进度 | 时间 | 下载 | 更多。
        整条和画面左右对齐、共享一个圆角矩形，读起来是"这条片子的
        操作台"，而不是几个碰巧挨着的按钮。

        分隔用 divide-x 的一像素描边，不用间距——有间距就又散成
        独立控件了，那正是要改掉的样子。
      */}
      <div className="mt-2 flex h-11 shrink-0 items-stretch divide-x divide-line overflow-hidden rounded-xl border border-line bg-ink-850">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? '暂停' : '播放'}
          className="flex w-12 shrink-0 items-center justify-center text-ink-100 transition-colors hover:bg-ink-800 hover:text-accent"
        >
          {playing ? <IconPause className="size-4" /> : <IconPlay className="size-4" />}
        </button>

        {/* 进度这一格吃掉所有余量——它是这条里唯一需要精细操作的地方 */}
        <div className="flex min-w-0 flex-1 items-center px-3">
          <input
            type="range"
            min={0}
            max={Math.max(dur, 0.01)}
            step={0.01}
            value={cur}
            onChange={(e) => {
              const t = Number(e.target.value)
              const v = videoRef.current
              if (v) v.currentTime = t
              setCur(t)
            }}
            className="min-w-0 flex-1 accent-accent"
            aria-label="播放进度"
          />
        </div>

        <div className="flex shrink-0 items-center px-3 text-[11px] tabular-nums text-ink-400">
          {fmt(cur)} / {fmt(dur)}
        </div>

        {/* 下载是这一栏的落点，整格铺强调色——一眼就知道往哪儿去 */}
        <a
          href={`/api/projects/${project.id}/film/download`}
          title="下载视频"
          aria-label="下载视频"
          className="flex w-12 shrink-0 items-center justify-center bg-accent text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconDownload className="size-4" />
        </a>

        <FilmMenu onRecompose={() => void recomposeFilm(project.id)} />
      </div>
    </div>
  )
}

/** 竖着的三个点。装那些"存在但不该占地方"的动作。 */
function FilmMenu ({ onRecompose }: { onRecompose: () => void }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={boxRef} className="relative flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="更多"
        title="更多"
        className="flex w-10 items-center justify-center text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
      >
        <IconMore className="size-4" />
      </button>
      {open && (
        // 向上展开：这条控制栏贴着栏底，向下会掉出视口
        <div className="absolute bottom-full right-0 z-30 mb-1 min-w-32 overflow-hidden rounded-lg border border-line bg-ink-850 py-1 shadow-2xl shadow-black/60">
          <button
            type="button"
            onClick={() => { setOpen(false); onRecompose() }}
            className="w-full whitespace-nowrap px-3 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-50"
          >
            重新合成一遍
          </button>
        </div>
      )}
    </div>
  )
}
