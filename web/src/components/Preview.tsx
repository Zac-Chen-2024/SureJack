import { useCallback, useEffect, useRef, useState } from 'react'
import JASSUB from 'jassub'
// jassub 用 `new Worker(url, { type: 'module' })` 起 worker、用 fetch 拿 wasm。
// 这三个 URL 显式交给 Vite 处理（?worker&url 会把 worker 连同它的依赖打成一个
// ES module 产物），比让 jassub 自己去猜 import.meta.url 可靠得多——尤其是
// 生产构建后文件会被搬到 assets/ 并加 hash。
import jassubWorkerUrl from 'jassub/dist/worker/worker.js?worker&url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url'
import { useProjects } from '../store/projects'
import { usePipeline, bgTrackNotice, bgTrackSrc, shouldPollBgTrack } from '../store/pipeline'
import { IconPlay, IconPause, IconPreview } from './ui/Icon'
import { DEFAULT_BGM_VOLUME } from '../constants'

/**
 * 字幕字体。**必须精确是这个族名**，不是 'Noto Sans SC'（那个族名根本不存在，
 * fc-match 会静默回退到零中文字形的 DejaVu Sans，渲染出一片豆腐块且不报错）。
 * 这里的字符串要和后端 src/config.ts 的 FONT_FAMILY 完全一致——
 * ASS 样式里写的 Fontname 就是它，libass 按这个名字来查字体。
 * availableFonts 的 key 必须小写，这是 jassub 的约定。
 */
const FONT_FAMILY = 'noto sans cjk sc'

/** 后端直接吐 ffmpeg 用的那一个字体文件，保证两端同一份字形 */
const FONT_URL = '/api/fonts/subtitle.ttc'

/** 和后端 ASPECT_PRESETS 一致：ASS 的 PlayResX/Y 就是这个，libass 按它算字号 */
const ASPECT: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
}

/** 画面与音频允许的最大偏差（秒）。超过就把画面拽回来。 */
const MAX_DRIFT_S = 0.15

function fmt (ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

interface Props {
  /**
   * 播放位置变化时回调（毫秒）。主代理接线用：喂给 subtitles store 的 currentMs，
   * 让时间轴高亮当前这一行。
   *
   * ⚠️ 方向是单向的：音频是唯一时间源，只能由这里往 store 推，
   * 绝不能反过来让 store 的 currentMs 回来驱动音频——那会形成环，
   * 表现是进度条自己抖动。要从外部跳转请用下面的 seek。
   */
  onTimeChange?: (ms: number) => void
  /**
   * 外部跳转请求（点时间轴某一行）。nonce 每次请求自增——只有 nonce 变了
   * 才会真的 seek，所以「连点同一行两次」也能生效，而正常播放导致的
   * currentMs 变化不会被误当成跳转。
   */
  seek?: { ms: number; nonce: number } | null
}

/**
 * 9:16 实时预览。
 *
 * ── 为什么是这个架构 ────────────────────────────────────────────────
 * 字幕用 JASSUB 渲染，而 JASSUB 就是 libass 的 wasm 版——和服务端 ffmpeg
 * 烧录字幕用的是同一个 C 库；两边读的又是同一份 ASS（GET subtitles.ass 和
 * 导出时写给 ffmpeg 的 subtitle.ass 都出自后端同一个 buildProjectAss）。
 * 所以「预览所见 = 导出所得」是架构保证的，不是靠调参凑出来的。
 * 不要改成用 DOM/CSS 画字幕——那等于把这个保证扔了。
 *
 * ── 为什么只有一个时钟 ──────────────────────────────────────────────
 * `<audio>`（配音）是唯一时间源，`<video>`（背景）muted loop 跟着它走。
 * 两个媒体元素各播各的必然漂移：它们由不同的解码器时钟驱动，几分钟下来
 * 能差出小半秒，字幕对得上声音却对不上画面。所以画面只做「跟随 + 超过
 * 阈值就拽回来」，从不参与计时；字幕也一律按音频时间渲染。
 */
export function Preview ({ onTimeChange, seek }: Props) {
  const project = useProjects((s) => s.current())
  const assets = usePipeline((s) => s.assets)
  const bgTrack = usePipeline((s) => s.bgTrack)
  const loadBgTrack = usePipeline((s) => s.loadBgTrack)

  const audioRef = useRef<HTMLAudioElement>(null)
  const bgmRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const jassubRef = useRef<JASSUB | null>(null)
  const rafRef = useRef<number>(0)

  const [ass, setAss] = useState<string | null>(null)
  const [assError, setAssError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)

  const projectId = project?.id ?? null
  const voice = assets.find((a) => a.kind === 'voice')
  const video = assets.find((a) => a.kind === 'video')
  const size = ASPECT[project?.aspectRatio ?? '9:16'] ?? ASPECT['9:16']!
  // 配音时长是权威值（ttsDurationMs 和词级时间戳同源）；音频元数据还没到时先用它
  const durationMs = project?.ttsDurationMs ?? 0

  // ── 拉 ASS 全文 ──────────────────────────────────────────────────
  // 依赖 updatedAt：改文案或重新生成配音都会刷新它，字幕跟着重取。
  // ASS 是现算的（后端不存），所以这里永远拿到的是最新版。
  useEffect(() => {
    if (!projectId) { setAss(null); return }
    let cancelled = false
    setAssError(null)
    fetch(`/api/projects/${projectId}/subtitles.ass`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`字幕加载失败（${res.status}）`)
        return res.text()
      })
      .then((text) => { if (!cancelled) setAss(text) })
      .catch((e: Error) => { if (!cancelled) { setAss(null); setAssError(e.message) } })
    return () => { cancelled = true }
  }, [projectId, project?.updatedAt, project?.ttsState])

  /*
   * ── 背景轨状态 ───────────────────────────────────────────────────
   * 配音一就绪，后端就在后台把背景轨拼好了（src/compose/prebuild.ts），
   * 预览直接播那一整条——**不用在浏览器里按排布逐段拼**，"画面跟随音频、
   * 漂出阈值才校正"那套逻辑一行都不用改。
   *
   * 还在拼的时候才轮询，拼好/拼不出来就停：终态还接着问，等于让两个
   * 用户的机器白跑一串请求。依赖里带 ttsState，因为重新生成配音会让
   * 排布变、后端重拼，那时要重新开始问。
   */
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void loadBgTrack(projectId)
    const timer = setInterval(() => {
      if (cancelled) return
      if (!shouldPollBgTrack(usePipeline.getState().bgTrack)) {
        clearInterval(timer)
        return
      }
      void loadBgTrack(projectId)
    }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [projectId, project?.ttsState, project?.ttsDurationMs, loadBgTrack])

  // ── 起 JASSUB ────────────────────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !ass) return

    // canvas 在 effect 里现建、清理时删掉，不用 JSX 里的固定元素：
    // transferControlToOffscreen() 对同一个 canvas 只能调一次，而 StrictMode
    // 下 effect 会跑两遍——复用同一个 canvas 第二次必抛 InvalidStateError，
    // 开发模式下预览直接白屏。每次给一个全新的 canvas，这个坑就不存在。
    const canvas = document.createElement('canvas')
    /*
     * 【z-index 必须显式给】：canvas 和 <video> 都是 position:absolute 且
     * 都没有 z-index 时，谁在上完全取决于 DOM 顺序——而 canvas 是在 effect
     * 里 appendChild 的，React 重渲染插入 <video> 之后顺序就不由我们说了算，
     * 字幕会被画面整个盖住。
     *
     * 这个 bug 一直存在，只是被「没有背景视频」掩盖着：以前 videoSrc 恒为
     * null，<video> 根本不渲染，canvas 自然在最上层。背景轨预生成一上线，
     * 画面出现了，字幕就没了。
     */
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10'
    stage.appendChild(canvas)

    const instance = new JASSUB({
      canvas,
      subContent: ass,
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      // JASSUB 用不了系统字体，字体必须显式喂进去。给的就是服务端 ffmpeg
      // 烧录时用的那个文件——「同一个渲染器」的前提是「同一个字体文件」。
      availableFonts: { [FONT_FAMILY]: FONT_URL },
      // 兜底字体也指向它：万一 ASS 里出现别的族名，回退结果仍有中文字形，
      // 不会退到 jassub 自带的 Liberation Sans（一个汉字都没有）。
      defaultFont: FONT_FAMILY,
      // 不查本地字体：会触发 local-fonts 权限询问（用户看到一个莫名其妙的
      // 授权弹窗），而且查到的字体和服务端的未必是同一份，正好破坏一致性。
      queryFonts: false,
    })
    jassubRef.current = instance

    return () => {
      jassubRef.current = null
      // 必须 destroy：JASSUB 每个实例背后是一个 worker + 一份 wasm 堆，
      // 切项目/卸载时不回收就是实打实的 worker 泄漏，切几次页面就卡了。
      void instance.destroy()
      canvas.remove()
    }
  }, [ass])

  /** 把字幕画到某个时刻。暂停时也要能画（seek 后要立刻看到那一帧的字幕）。 */
  const renderAt = useCallback((ms: number) => {
    void jassubRef.current?.manualRender({
      mediaTime: ms / 1000,
      // width/height 报的是 ASS 的 PlayRes 而非 canvas 像素——libass 按
      // PlayRes 坐标系排版，jassub 再缩放到 canvas。报错了字号会整体偏大或偏小。
      width: size.width,
      height: size.height,
      expectedDisplayTime: performance.now(),
    })
  }, [size.width, size.height])

  // ── 播放循环 ─────────────────────────────────────────────────────
  // 每帧从 audio 读时间（唯一时间源），拿它去驱动字幕和画面。
  useEffect(() => {
    if (!playing) return
    let lastPushed = -1

    const tick = () => {
      const audio = audioRef.current
      if (audio) {
        const t = audio.currentTime
        renderAt(t * 1000)

        // 状态更新按 50ms 粒度节流：进度条和时间轴高亮根本用不着 60fps，
        // 而每帧 setState 会让整棵子树跟着重渲染。字幕本身走 canvas，
        // 不受这个节流影响，仍是逐帧的。
        const ms = Math.round(t * 1000)
        if (Math.abs(ms - lastPushed) >= 50) {
          lastPushed = ms
          setCurrentMs(ms)
          onTimeChange?.(ms)
        }

        // 画面跟随：只在漂出阈值时才校正。每帧写 currentTime 会让解码器
        // 不断重新定位，画面变成一卡一卡的幻灯片。
        const v = videoRef.current
        if (v && v.duration > 0 && Number.isFinite(v.duration)) {
          const want = t % v.duration
          if (Math.abs(v.currentTime - want) > MAX_DRIFT_S) v.currentTime = want
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, renderAt, onTimeChange])

  // 字幕刚起来、或暂停状态下换了项目时，先画一帧，别让预览框空着
  useEffect(() => { if (ass) renderAt(currentMs) }, [ass, renderAt])   // eslint-disable-line react-hooks/exhaustive-deps

  /** 统一的跳转入口：音频是时间源，所以一切跳转都先落到 audio 上 */
  const seekTo = useCallback((ms: number) => {
    const audio = audioRef.current
    const clamped = Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms)
    if (audio) audio.currentTime = clamped / 1000
    const v = videoRef.current
    if (v && v.duration > 0 && Number.isFinite(v.duration)) v.currentTime = (clamped / 1000) % v.duration
    /*
     * BGM 也要跟着跳，但要【取模】——它比配音短得多（库里 7.6-11.6 分钟，
     * 而配音可以 13 分钟），成片里是循环铺满的。直接把 currentTime 设成
     * 超出它自身时长的值，浏览器会夹到末尾、听起来就是没声音了。
     * 取模才对应"循环播放"里真正该响的那一刻。
     */
    const b = bgmRef.current
    if (b && b.duration > 0 && Number.isFinite(b.duration)) b.currentTime = (clamped / 1000) % b.duration
    setCurrentMs(clamped)
    renderAt(clamped)
    onTimeChange?.(clamped)
  }, [durationMs, renderAt, onTimeChange])

  // 外部跳转（时间轴点某一行）。只认 nonce 变化，见 Props.seek 的说明。
  const seekNonce = seek?.nonce
  useEffect(() => {
    if (seek) seekTo(seek.ms)
  }, [seekNonce])   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(() => {
    const audio = audioRef.current
    const v = videoRef.current
    const b = bgmRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      v?.pause()
      b?.pause()
      setPlaying(false)
    } else {
      /*
       * 配音先起播，画面和 BGM 跟着它。
       *
       * 【BGM 起播失败不能拖垮整个预览】：它是陪衬，没有它照样能看字幕
       * 和听配音。所以它的 play() 单独 catch 掉——放进主链里的话，
       * 一次 BGM 解码失败会让 setPlaying(false)，用户点了播放却什么都没发生。
       */
      void audio.play().then(() => {
        void v?.play()
        void b?.play().catch(() => {})
      }).catch(() => setPlaying(false))
      setPlaying(true)
    }
  }, [playing])

  // 切项目时把播放状态收干净，免得新项目一进来就是"正在播"但没有声音
  useEffect(() => {
    setPlaying(false)
    setCurrentMs(0)
  }, [projectId])

  /*
   * BGM 音量跟着素材栏那个滑块实时变。
   *
   * 【要和导出用同一个值】：成片里 ffmpeg 的 volume 滤镜吃的就是
   * project.bgmVolume，这里如果另设一个数，用户在预览里调准了、
   * 导出却是另一个响度——"预览即成片"就破了一半（画面对了声音不对）。
   */
  useEffect(() => {
    const b = bgmRef.current
    if (b) b.volume = Math.min(1, Math.max(0, project?.bgmVolume ?? DEFAULT_BGM_VOLUME))
  }, [project?.bgmVolume])

  if (!project) return null

  const voiceSrc = voice ? `/api/assets/${voice.id}` : null
  // BGM 来自【素材库】不是项目素材，所以走 library 接口
  const bgmSrc = project?.bgmLibraryId ? `/api/library/items/${project.bgmLibraryId}` : null
  /*
   * 上传过背景视频的老项目仍旧播它自己那一条——那条路径一个字都没改。
   * 没上传的（新前端的唯一形态）播后台拼好的背景轨，和成片是同一个文件。
   */
  const videoSrc = video ? `/api/assets/${video.id}` : bgTrackSrc(bgTrack)
  const ready = Boolean(voiceSrc && ass)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconPreview className="size-3.5" />预览
      </div>

      {/* 严格 9:16：用 aspect-ratio 而不是写死像素，四栏布局怎么伸缩都不会变形 */}
      <div
        ref={stageRef}
        className="relative mx-auto w-full max-w-full overflow-hidden rounded-xl border border-line bg-ink-900"
        style={{ aspectRatio: `${size.width} / ${size.height}` }}
      >
        {videoSrc && (
          <video
            ref={videoRef}
            src={videoSrc}
            // muted + loop + playsInline 三个都不能省：muted 是画面能自动
            // 起播的前提（浏览器只拦有声自动播放），而它本来就不该出声——
            // 声音全部来自那唯一的 <audio>。loop 让短素材铺满整条配音。
            muted
            loop
            playsInline
            preload="metadata"
            className="absolute inset-0 z-0 size-full object-cover"
          />
        )}
        {/*
          这里【曾经】浮着一句「还没有背景视频，先看字幕版式」，用的是
          absolute bottom-3 —— 正好压在字幕的位置上。提示不该盖住它所提示的
          对象：用户点开预览就是来看字幕版式的，结果被这句话挡了半行。
          移到画框【外面】去了，见组件末尾的 tip。
        */}

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <IconPreview className="size-7 text-ink-600" />
            <p className="text-sm text-ink-300">
              {assError ? assError
                : !voiceSrc ? '还没有配音，先点「生成配音」'
                  : '字幕加载中…'}
            </p>
            {!voiceSrc && !assError && (
              <p className="text-xs leading-relaxed text-ink-400">
                预览以配音为时间轴——字幕的每一个字什么时候亮，
                都来自配音的词级时间戳，所以得先有声音。
              </p>
            )}
          </div>
        )}
      </div>

      {/* 唯一时间源。不给 controls：播放/暂停/进度全部走下面那套自绘控件，
          两套控件同时存在会让人以为是两个播放器。 */}
      {voiceSrc && (
        <audio
          ref={audioRef}
          src={voiceSrc}
          preload="metadata"
          onEnded={() => {
            setPlaying(false)
            videoRef.current?.pause()
            // 配音结束时 BGM 必须一起停。它自己是 loop 的，不停就会
            // 在静止的画面上一直响下去——成片里 amix duration=first
            // 在配音结束时截断，预览也要照做才叫"所见即所得"。
            bgmRef.current?.pause()
          }}
        />
      )}

      {/*
        背景音乐。和配音同步启停、同步跳转，但【不参与计时】——
        时间源永远是配音那一条，这是整个预览的地基（见组件头部说明）。

        loop：库里 9 首是 7.6–11.6 分钟，而配音可以到 13 分钟。
        成片里 ffmpeg 用 -stream_loop -1 循环铺满，预览用原生 loop
        达到同样效果；两边都循环，听感才对得上。
      */}
      {bgmSrc && (
        <audio ref={bgmRef} src={bgmSrc} loop preload="metadata" />
      )}

      <div className="mt-2 flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          disabled={!ready}
          aria-label={playing ? '暂停' : '播放'}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-ink-100 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:border-line disabled:text-ink-600 disabled:hover:border-line disabled:hover:text-ink-600"
        >
          {playing ? <IconPause className="size-4" /> : <IconPlay className="size-4" />}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(durationMs, 1)}
          value={Math.min(currentMs, Math.max(durationMs, 1))}
          disabled={!ready || durationMs <= 0}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="播放进度"
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 disabled:cursor-not-allowed"
          // accent-color 让原生滑块吃项目主色，不用手写四套浏览器伪元素样式
          style={{ accentColor: 'var(--color-accent)' }}
        />

        <span className="shrink-0 text-[11px] tabular-nums text-ink-400">
          {fmt(currentMs)} / {fmt(durationMs)}
        </span>
      </div>

      {/*
        背景缺席的说明放在画框【外面】。原来它浮在画面底部，正好压住字幕——
        而用户点开预览恰恰是来看字幕版式的，提示不该盖住它所提示的对象。

        文案现在按背景轨的真实状态分岔（见 store 的 bgTrackNotice）：
        拼好了这里【一句话都不说】，因为背景就在上面的画框里；还在拼说
        「生成中」；拼不出来要说清【导出时会重新生成】——预拼只是个优化，
        它失败了后端会回退到即时生成，别让预览的失败看着像导出会失败。
      */}
      {!videoSrc && ready && bgTrackNotice(bgTrack) !== null && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-400">
          <IconPreview className="mt-px size-3 shrink-0 text-ink-600" />
          <span>{bgTrackNotice(bgTrack)}</span>
        </p>
      )}
    </div>
  )
}
