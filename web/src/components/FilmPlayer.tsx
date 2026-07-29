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
  // 母带版本：换 BGM 时它不变 → 视频 src 不变 → 视频不重载。这是"换 BGM 不卡"的关键
  const masterVersion = usePipeline((s) => s.film?.masterVersion ?? null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const bgmRef = useRef<HTMLAudioElement>(null)
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

  // 调 BGM 音量：不重载音轨，只改 volume（0..1，钳一层防脏值）
  useEffect(() => {
    const b = bgmRef.current
    if (b) b.volume = Math.min(1, Math.max(0, project?.bgmVolume ?? 0.15))
  }, [project?.bgmVolume])

  // 外部跳转（点字幕某一行）。BGM 跟着跳到对应的循环相位
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!seek || seek.nonce === lastNonce.current) return
    lastNonce.current = seek.nonce
    const v = videoRef.current
    if (v) v.currentTime = seek.ms / 1000
    syncBgm(seek.ms / 1000)
  }, [seek])

  /*
   * 把 BGM 音轨对到视频的某一刻。BGM 是循环的、比视频短，直接 set 到
   * 超过它自身时长的值浏览器会夹到末尾（听着像没声），取模才对应
   * "循环播放"里真正该响的那一刻。
   */
  function syncBgm (videoSec: number): void {
    const b = bgmRef.current
    if (b && b.duration > 0 && Number.isFinite(b.duration)) {
      b.currentTime = videoSec % b.duration
    }
  }

  if (!project) return null

  /*
   * 预览播【母带】(画面+字幕+配音，无 BGM)，BGM 在下面另叠一条 <audio>。
   * src 键在 masterVersion 上：换 BGM / 调音量都不改它 → 视频一帧不动、无缝切；
   * 改文案/字幕/语速才改它 → 视频重新拉母带。masterVersion 还没回来时
   * 退回 updatedAt，至少能播上。
   */
  const ver = masterVersion ?? project.updatedAt
  const src = `/api/projects/${project.id}/film/master/stream?v=${encodeURIComponent(ver)}`
  // BGM 来自素材库（全局公用），不是项目素材
  const bgmSrc = project.bgmLibraryId ? `/api/library/items/${project.bgmLibraryId}` : null

  const toggle = () => {
    const v = videoRef.current
    const b = bgmRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
      if (b) { syncBgm(v.currentTime); void b.play() }
      setPlaying(true)
    } else {
      v.pause(); b?.pause()
      setPlaying(false)
    }
  }

  return (
    /*
     * 【没有标题】。这一栏的列头已经写着"预览"，画面本身也一眼就知道是
     * 什么——再加一行"成片"只是把几十像素的高度从画面上拿走。
     * 竖屏 9:16 里高度是最紧的资源，每一行都要还得起。
     */
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="relative mx-auto w-full max-w-full overflow-hidden rounded-xl border border-line bg-black [container-type:inline-size]"
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
          onEnded={() => { setPlaying(false); bgmRef.current?.pause() }}
          onPause={() => { setPlaying(false); bgmRef.current?.pause() }}
          onPlay={() => setPlaying(true)}
        />
        <SubtitleGuide />
      </div>

      {/*
        背景音乐叠在视频上，浏览器里混音。这条就是"换 BGM 不卡"的实现：
        换 BGM 只让 bgmSrc 变、这个 <audio> 换源，视频一帧不动。
        loop：库里的曲子比配音短，循环铺满。muted 的视频负责画面+人声，
        音量只作用于这条 BGM（bgmVolume 是相对配音的比例）。
        key 用 bgmSrc：换曲子时强制重建元素，避免旧曲的播放位置串味。
      */}
      {bgmSrc && (
        <audio
          key={bgmSrc}
          ref={bgmRef}
          src={bgmSrc}
          loop
          preload="metadata"
          onLoadedMetadata={(e) => {
            e.currentTarget.volume = Math.min(1, Math.max(0, project.bgmVolume))
            // 用户是在播放中途换的曲子：立刻对到当前进度并接着放
            if (playing) { syncBgm(videoRef.current?.currentTime ?? 0); void e.currentTarget.play() }
          }}
        />
      )}

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
              syncBgm(t)
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

/**
 * 拖字幕高度时，在画面上画出那条字幕【将会】落在的位置。
 *
 * 存在的理由：改字幕高度要重烧十几分钟，所以不能"改完看效果"——
 * 得先看效果再决定改不改。而用户此刻要判断的只有一件事：会不会压到
 * 人脸。那纯粹是纵向位置的问题，用一条线加一行示意文字就够了，
 * 不需要真去渲染一遍字幕。
 *
 * 【坐标怎么换算】MarginV 是 ASS 里以 PlayRes 高度（1920）为基准的
 * 底边距。画面是等比缩放到这个框里的，所以同一个比例 marginV/1920
 * 直接就是距底部的百分比。
 *
 * 没有草稿值时什么都不画——它只在"正在调"的那几十秒里出现。
 */
function SubtitleGuide () {
  const project = useProjects((s) => s.current())
  const draftMargin = useProjects((s) => s.draftMarginV)
  const draftSize = useProjects((s) => s.draftFontSize)
  if (draftMargin === null && draftSize === null) return null

  const PLAY_RES_X = 1080
  const PLAY_RES_Y = 1920
  const margin = draftMargin ?? project?.subtitleMarginV ?? 300
  const size = draftSize ?? project?.subtitleFontSize ?? 64

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center"
      style={{ bottom: `${(margin / PLAY_RES_Y) * 100}%` }}
    >
      {/*
        字号也按 PlayRes 等比换算：ASS 里的 64 号字在 1080 宽的画面上
        占 64/1080 的高度，用 cqw 换算到当前画框宽度就是同一个视觉大小。
        （画框已经声明了 container-type:inline-size）
      */}
      <span
        className="whitespace-nowrap font-bold text-accent"
        style={{
          fontSize: `${(size / PLAY_RES_X) * 100}cqw`,
          textShadow: '0 2px 8px rgba(0,0,0,0.9)',
        }}
      >
        字幕大概长这样
      </span>
      <div className="mt-1 h-px w-full bg-accent/70" />
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
