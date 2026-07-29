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
  playing: boolean
  /** 当前秒 / 总秒 */
  cur: number
  dur: number
  /** 母带流地址（键在盘上版本，换 BGM 不变） */
  src: string | null
  /** 选中的库 BGM，没选就 null */
  bgmSrc: string | null
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
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  // ── Web Audio 图：source(=bgm 元素) → gain → destination ─────────────
  const ctxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  // 记住 source 是给哪个元素建的——换 BGM 会重挂 <audio>，元素变了就得重建
  const srcElRef = useRef<HTMLAudioElement | null>(null)

  const bgmVol = Math.min(1, Math.max(0, project?.bgmVolume ?? 0.15))
  const bgmVolRef = useRef(bgmVol)
  bgmVolRef.current = bgmVol

  /** 把当前 bgm 元素接进 Web Audio 图（幂等）。拿不到就返回 false，走回退。 */
  function ensureGraph (): boolean {
    const el = bgmRef.current
    if (!el) return false
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return false
      if (!ctxRef.current) {
        ctxRef.current = new AC()
        gainRef.current = ctxRef.current.createGain()
        gainRef.current.connect(ctxRef.current.destination)
      }
      if (srcElRef.current !== el) {
        try { srcNodeRef.current?.disconnect() } catch { /* 旧节点已随元素卸载 */ }
        srcNodeRef.current = ctxRef.current.createMediaElementSource(el)
        srcNodeRef.current.connect(gainRef.current!)
        srcElRef.current = el
      }
      void ctxRef.current.resume()
      return true
    } catch { return false }
  }

  /** 上音量：有 gain 就走 gain（元素放满），否则回退到 element.volume */
  function applyVolume (): void {
    const el = bgmRef.current
    if (gainRef.current) {
      gainRef.current.gain.value = bgmVolRef.current
      if (el) el.volume = 1
    } else if (el) {
      el.volume = bgmVolRef.current
    }
  }

  // 卸载时收掉 AudioContext，别让它挂着
  useEffect(() => () => { try { void ctxRef.current?.close() } catch { /* 已关 */ } }, [])

  // 换项目：停下、回到开头
  useEffect(() => { setPlaying(false); setCur(0); setDur(0) }, [project?.id])

  // 调 BGM 音量：优先 gain，回退 element.volume
  useEffect(() => { applyVolume() }, [project?.bgmVolume])

  function syncBgm (videoSec: number): void {
    const b = bgmRef.current
    if (b && b.duration > 0 && Number.isFinite(b.duration)) b.currentTime = videoSec % b.duration
  }

  // 外部跳转（点字幕某一行）。只认 nonce 变化
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!seek || seek.nonce === lastNonce.current) return
    lastNonce.current = seek.nonce
    const v = videoRef.current
    if (v) v.currentTime = seek.ms / 1000
    syncBgm(seek.ms / 1000)
  }, [seek])

  const ver = masterOnDisk ?? project?.updatedAt ?? '0'
  const src = project ? `/api/projects/${project.id}/film/master/stream?v=${encodeURIComponent(ver)}` : null
  const bgmSrc = project?.bgmLibraryId ? `/api/library/items/${project.bgmLibraryId}` : null

  const toggle = (): void => {
    const v = videoRef.current, b = bgmRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
      if (b) { ensureGraph(); applyVolume(); syncBgm(v.currentTime); void b.play() }
      setPlaying(true)
    } else {
      v.pause(); b?.pause(); setPlaying(false)
    }
  }
  const seekTo = (sec: number): void => {
    const v = videoRef.current
    if (v) v.currentTime = sec
    syncBgm(sec); setCur(sec)
  }
  const onTimeUpdate = (sec: number): void => {
    setCur(sec)
    onTimeChange?.(Math.round(sec * 1000))
    // 持续纠偏：只在漂移超阈值时硬拉回，避免频繁 set 造成咔哒
    const b = bgmRef.current
    if (b && !b.paused && b.duration > 0 && Number.isFinite(b.duration)) {
      const expected = sec % b.duration
      if (Math.abs(b.currentTime - expected) > DRIFT_TOLERANCE) b.currentTime = expected
    }
  }
  const handlePlay = (): void => { setPlaying(true) }
  const handleStop = (): void => { setPlaying(false); bgmRef.current?.pause() }
  // 视频缓冲：BGM 先停，别让它在黑屏时独自往前跑
  const handleWaiting = (): void => { bgmRef.current?.pause() }
  // 缓冲结束：对齐当前视频位置再续上（仅当我们本就该在播）
  const handlePlaying = (): void => {
    const v = videoRef.current, b = bgmRef.current
    setPlaying(true)
    if (v && b) { ensureGraph(); applyVolume(); syncBgm(v.currentTime); void b.play() }
  }
  const onBgmReady = (): void => {
    ensureGraph(); applyVolume()
    // 用户在播放中途换的曲子：立刻对到当前进度并接着放
    const v = videoRef.current, b = bgmRef.current
    if (playing && v && b) { syncBgm(v.currentTime); void b.play() }
  }

  return {
    videoRef, bgmRef, playing, cur, dur, src, bgmSrc, composing, progress,
    toggle, seekTo, onLoadedMeta: setDur, onTimeUpdate,
    handlePlay, handleStop, handleWaiting, handlePlaying, onBgmReady,
  }
}
