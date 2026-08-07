import { useEffect, useRef, useState, type RefObject } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'

/**
 * 成片播放的全部逻辑，桌面(FilmPlayer)和手机(MobileFilmPlayer)共用。
 *
 * 只有【呈现】不同——桌面是带边框的框、手机是边到边全屏叠加控制——但底下
 * 这套东西完全一样：播母带、浏览器叠 BGM、循环相位同步、母带过期时的
 * 合成蒙层、视频 src 键在盘上母带版本上（换 BGM 不重载）。所以抽出来，
 * 免得两处各写一遍、迟早漂。
 *
 * ── BGM 为什么走 Web Audio（GainNode），不用 element.volume ──────────
 * 【iOS 的坑】：Safari / iOS 上 HTMLMediaElement.volume 是**只读**的，
 * 设了没用——音量只归硬件音量键管。于是手机上"背景音乐音量"滑块完全
 * 失灵，而且 BGM 一直满音量盖过配音。解法是把这条 <audio> 接进 Web Audio
 * 图：source → GainNode → destination，音量改 gain（iOS 认这个）。
 * 桌面上 gain 一样有效，两端统一。拿不到 AudioContext 的老环境回退到
 * element.volume（老行为）。
 *
 * ── 两个时钟必然漂移，要持续纠偏 ────────────────────────────────────
 * 视频（含配音）和 BGM 是两个独立的 <media> 元素、两套时钟。只在
 * play/seek 对一次齐，放着放着就散（尤其手机上视频卡一下去缓冲、BGM
 * 照跑）。所以：① timeupdate 里持续检查漂移、超阈值才硬拉回（频繁 set
 * currentTime 会咔咔响，所以要设阈值）；② 视频 waiting 就把 BGM 停住，
 * playing 再对齐续上。
 *
 * 用法：组件拿 videoRef/bgmRef 挂到 <video>/<audio>，把各 on* 事件接上，
 * 控制条调 toggle/seekTo，<audio> 的 onLoadedMetadata 调 onBgmReady。
 */
export interface FilmPlayback {
  videoRef: RefObject<HTMLVideoElement | null>
  bgmRef: RefObject<HTMLAudioElement | null>
  /** 配音轨。母带只有画面，配音是独立的一条流 */
  voiceRef: RefObject<HTMLAudioElement | null>
  playing: boolean
  /** 当前秒 / 总秒 */
  cur: number
  dur: number
  /** 母带流地址（键在盘上版本，换 BGM 不变） */
  src: string | null
  /** 选中的库 BGM，没选就 null */
  bgmSrc: string | null
  /** 配音流的地址。还没配音时是 null */
  voiceSrc: string | null
  /** 首帧封面（服务端 ffmpeg 抓的）。给 <video poster> 用——进页面立刻是画面，
   *  而不是安卓 WebView 那个丑的默认播放键占位图 */
  poster: string | null
  /** 母带正在重烧（改了文案/字幕/语速）+ 进度，给"合成中"蒙层用 */
  composing: boolean
  progress: number
  toggle: () => void
  seekTo: (sec: number) => void
  onLoadedMeta: (dur: number) => void
  onTimeUpdate: (sec: number) => void
  /** <video> 的 onPlay：把播放态同步过来 */
  handlePlay: () => void
  /** <video> 的 onPause / onEnded：停下并暂停 BGM */
  handleStop: () => void
  /** <video> 的 onWaiting：视频在缓冲，先把 BGM 停住别让它跑掉 */
  handleWaiting: () => void
  /** <video> 的 onPlaying：缓冲结束真正开播，重新对齐并续上 BGM */
  handlePlaying: () => void
  /** <audio> 的 onLoadedMetadata：接进 Web Audio 图、上音量，播放中就对齐续上 */
  onBgmReady: () => void

  /* ── 缓冲状态：给"视频加载中 xx%"用 ──────────────────────────────── */
  /** 元数据还没到（连总时长都不知道），这时候连进度条都是假的 */
  metaReady: boolean
  /** 正卡在缓冲上（onWaiting 到 onPlaying 之间） */
  buffering: boolean
  /** 从播放头往后已经缓冲到哪儿了，占总时长的百分比 0–100 */
  bufferedPct: number
  /** <video> 的 onProgress / onCanPlay：刷新已缓冲区间 */
  onProgress: (v: HTMLVideoElement) => void
  onCanPlay: () => void
}

/** 漂移超过这么多秒才硬拉回——低于它别动，频繁 set currentTime 会有咔哒声 */
const DRIFT_TOLERANCE = 0.35

export function useFilmPlayback (
  onTimeChange?: (ms: number) => void,
  seek?: { ms: number; nonce: number } | null,
): FilmPlayback {
  const project = useProjects((s) => s.current())
  const masterOnDisk = usePipeline((s) => s.film?.masterOnDisk ?? null)
  const filmState = usePipeline((s) => s.film?.state ?? null)
  const progress = usePipeline((s) => s.film?.progress ?? 0)
  const masterStale = usePipeline((s) => s.film?.masterStale === true)
  const composing = filmState === 'building' && masterStale

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const bgmRef = useRef<HTMLAudioElement | null>(null)
  /*
   * ⚠️【配音现在是独立的一条轨，不在画面里】。
   *
   * 母带只有画面（见 compose/film.ts）——配音和音乐都只在【下载】那一刻
   * 才烧进文件。所以预览要自己把三条流叠起来播：画面 + 配音 + 音乐。
   *
   * 这么做换来的是【调音量零成本】：从前拖一下滑块要重混一个 100MB 的文件，
   * 现在只是改一个 gain。代价是同步得自己管，见下面的漂移纠正。
   */
  const voiceRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  // ── Web Audio 图：source(=bgm 元素) → gain → destination ─────────────
  const ctxRef = useRef<AudioContext | null>(null)
  /** 每条轨一套 {gain, source, 建给了哪个元素}。换源会重挂 <audio>，元素变了要重建 */
  interface Lane {
    gain: GainNode | null
    src: MediaElementAudioSourceNode | null
    el: HTMLAudioElement | null
  }
  const bgmLane = useRef<Lane>({ gain: null, src: null, el: null })
  const voiceLane = useRef<Lane>({ gain: null, src: null, el: null })

  const bgmVol = Math.min(1, Math.max(0, project?.bgmVolume ?? 0.15))
  const bgmVolRef = useRef(bgmVol)
  bgmVolRef.current = bgmVol
  /*
   * ⚠️【上限 4，和后端钳位一致】。播放器和混音必须用【同一个数】，
   * 否则"听到的 = 下载到的"当场破功——这正是这套改动的全部意义。
   */
  const voiceVol = Math.min(4, Math.max(0, project?.voiceGain ?? 1))
  const voiceVolRef = useRef(voiceVol)
  voiceVolRef.current = voiceVol

  /** 把一个音频元素接进 Web Audio 图（幂等）。拿不到就返回 false，走回退 */
  function ensureLane (lane: { current: Lane }, el: HTMLAudioElement | null): boolean {
    if (!el) return false
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return false
      if (!ctxRef.current) ctxRef.current = new AC()
      if (!lane.current.gain) {
        lane.current.gain = ctxRef.current.createGain()
        lane.current.gain.connect(ctxRef.current.destination)
      }
      if (lane.current.el !== el) {
        try { lane.current.src?.disconnect() } catch { /* 旧节点已随元素卸载 */ }
        lane.current.src = ctxRef.current.createMediaElementSource(el)
        lane.current.src.connect(lane.current.gain)
        lane.current.el = el
      }
      void ctxRef.current.resume()
      return true
    } catch { return false }
  }

  /**
   * 上音量：有 gain 就走 gain（元素放满），否则回退到 element.volume。
   * ⚠️ 回退路径【夹到 1】：HTMLMediaElement.volume 超过 1 会抛，
   * 而配音增益是可以到 4 的。拿不到 Web Audio 的老环境只能放弃增益，
   * 但不能因此让整个播放器崩掉。
   */
  function applyVolume (): void {
    const b = bgmRef.current
    if (bgmLane.current.gain) {
      bgmLane.current.gain.gain.value = bgmVolRef.current
      if (b) b.volume = 1
    } else if (b) b.volume = Math.min(1, bgmVolRef.current)

    const v = voiceRef.current
    if (voiceLane.current.gain) {
      voiceLane.current.gain.gain.value = voiceVolRef.current
      if (v) v.volume = 1
    } else if (v) v.volume = Math.min(1, voiceVolRef.current)
  }

  /** 两条轨一起接图 */
  function ensureGraph (): boolean {
    const a = ensureLane(bgmLane, bgmRef.current)
    const b = ensureLane(voiceLane, voiceRef.current)
    return a || b
  }

  // 卸载时收掉 AudioContext，别让它挂着
  useEffect(() => () => { try { void ctxRef.current?.close() } catch { /* 已关 */ } }, [])

  // 换项目：停下、回到开头
  useEffect(() => { setPlaying(false); setCur(0); setDur(0) }, [project?.id])

  // 调音量：优先 gain，回退 element.volume。两条轨任一变了都要重上
  useEffect(() => { applyVolume() }, [project?.bgmVolume, project?.voiceGain])

  /**
   * 把两条音轨拉到视频的位置。
   *
   * ⚠️ 两者【对齐方式不同】：BGM 比片子短会循环铺满（和烧录时的
   * -stream_loop -1 一致），所以取模；配音和画面是一一对应的，直接对齐。
   * 取模用错地方会让配音在长片子里从头开始重播。
   */
  function syncAudio (videoSec: number): void {
    const b = bgmRef.current
    if (b && b.duration > 0 && Number.isFinite(b.duration)) b.currentTime = videoSec % b.duration
    const v = voiceRef.current
    if (v && Number.isFinite(v.duration)) v.currentTime = Math.min(videoSec, v.duration)
  }

  // 外部跳转（点字幕某一行）。只认 nonce 变化
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!seek || seek.nonce === lastNonce.current) return
    lastNonce.current = seek.nonce
    const v = videoRef.current
    if (v) v.currentTime = seek.ms / 1000
    syncAudio(seek.ms / 1000)
  }, [seek])

  const ver = masterOnDisk ?? project?.updatedAt ?? '0'
  /*
   * 末尾的 `#t=0.001` 是【媒体片段】，只作用于播放器、不会发给服务器。
   * 作用：让 WebView/浏览器把播放头落在开头并【渲染出第一帧】，于是未播放时
   * 看到的是画面本身，而不是安卓 WebView 那个又大又丑的默认播放键占位图。
   */
  const src = project ? `/api/projects/${project.id}/film/master/stream?v=${encodeURIComponent(ver)}#t=0.001` : null
  const bgmSrc = project?.bgmLibraryId ? `/api/library/items/${project.bgmLibraryId}` : null
  /*
   * 配音的流。键在 ttsState 上：重新配音会换一条新的 voice.mp3，
   * 不带键的话浏览器会一直用缓存里那条旧的。
   */
  const voiceSrc = project && project.ttsState === 'ready'
    ? `/api/projects/${project.id}/voice/stream?v=${encodeURIComponent(project.updatedAt)}`
    : null
  // 键在母带版本上：母带重烧才换新封面，否则长缓存命中、瞬开
  const poster = project ? `/api/projects/${project.id}/film/poster.jpg?v=${encodeURIComponent(ver)}` : null

  const toggle = (): void => {
    const v = videoRef.current
    if (!v) return
    const b = bgmRef.current, a = voiceRef.current
    if (v.paused) {
      /*
       * ⚠️【三条流必须在同一个用户手势里一起 play】。浏览器的自动播放策略
       * 只放行"用户点击直接触发"的播放；放到 await 之后或定时器里再启动
       * 配音，iOS 会静默拒绝——画面在动、没有声音，而且完全不报错。
       */
      ensureGraph(); applyVolume(); syncAudio(v.currentTime)
      void v.play()
      if (b) void b.play()
      if (a) void a.play()
      setPlaying(true)
    } else {
      v.pause(); b?.pause(); a?.pause(); setPlaying(false)
    }
  }
  const seekTo = (sec: number): void => {
    const v = videoRef.current
    if (v) v.currentTime = sec
    syncAudio(sec); setCur(sec)
  }
  const onTimeUpdate = (sec: number): void => {
    setCur(sec)
    onTimeChange?.(Math.round(sec * 1000))
    /*
     * 持续纠偏：只在漂移超阈值时硬拉回，避免频繁 set 造成咔哒。
     * 【视频是主时钟】——三个媒体元素各走各的，不定期拉回的话，
     * 十几分钟的片子到后面能差出几百毫秒，字幕和人声就对不上了。
     */
    const b = bgmRef.current
    if (b && !b.paused && b.duration > 0 && Number.isFinite(b.duration)) {
      const expected = sec % b.duration
      if (Math.abs(b.currentTime - expected) > DRIFT_TOLERANCE) b.currentTime = expected
    }
    const a = voiceRef.current
    if (a && !a.paused && Number.isFinite(a.duration)) {
      if (Math.abs(a.currentTime - sec) > DRIFT_TOLERANCE) a.currentTime = Math.min(sec, a.duration)
    }
  }
  /*
   * 【缓冲要有可见的量】。片子几十 MB，在网络慢的地方点开就是一片黑，
   * 用户不知道是"在下"还是"坏了"——一个百分比就能把这两件事分开。
   * buffered 是一组区间，只认【盖住当前播放头】的那一段：别的区间再长
   * 也不代表马上能接着播。
   */
  const [buffering, setBuffering] = useState(false)
  const [bufferedPct, setBufferedPct] = useState(0)
  const onProgress = (v: HTMLVideoElement): void => {
    const total = v.duration
    if (!Number.isFinite(total) || total <= 0) return
    let end = 0
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.25) end = Math.max(end, v.buffered.end(i))
    }
    setBufferedPct(Math.min(100, Math.round((end / total) * 100)))
  }
  const onCanPlay = (): void => { setBuffering(false) }

  const handlePlay = (): void => { setPlaying(true) }
  /*
   * ⚠️【暂停/卡顿要把【两条】音轨都停住】。漏掉配音那条的后果很难受：
   * 视频缓冲转圈时人声还在自顾自地念，回来之后就永远对不上了。
   */
  const handleStop = (): void => {
    setPlaying(false); bgmRef.current?.pause(); voiceRef.current?.pause()
  }
  // 视频缓冲：BGM 先停，别让它在黑屏时独自往前跑
  const handleWaiting = (): void => {
    setBuffering(true); bgmRef.current?.pause(); voiceRef.current?.pause()
  }
  // 缓冲结束：对齐当前视频位置再续上（仅当我们本就该在播）
  const handlePlaying = (): void => {
    const v = videoRef.current
    setPlaying(true)
    setBuffering(false)
    if (v) {
      ensureGraph(); applyVolume(); syncAudio(v.currentTime)
      void bgmRef.current?.play()
      void voiceRef.current?.play()
    }
  }
  /**
   * 某条音轨的元数据到了（换了曲子、或配音刚生成）。
   * 立刻接图、上音量；正在播的话对到当前进度接着放。
   */
  const onBgmReady = (): void => {
    ensureGraph(); applyVolume()
    const v = videoRef.current
    if (playing && v) {
      syncAudio(v.currentTime)
      void bgmRef.current?.play()
      void voiceRef.current?.play()
    }
  }

  return {
    videoRef, bgmRef, voiceRef, playing, cur, dur, src, bgmSrc, voiceSrc, poster, composing, progress,
    toggle, seekTo, onLoadedMeta: setDur, onTimeUpdate,
    handlePlay, handleStop, handleWaiting, handlePlaying, onBgmReady,
    metaReady: dur > 0, buffering, bufferedPct, onProgress, onCanPlay,
  }
}
