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
 * 用法：组件拿 videoRef/bgmRef 挂到 <video>/<audio>，把 onLoaded/onTime
 * 接到对应事件，控制条调 toggle/seekTo。
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
}

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

  // 换项目：停下、回到开头
  useEffect(() => { setPlaying(false); setCur(0); setDur(0) }, [project?.id])

  // 调 BGM 音量：不重载，只改 volume
  useEffect(() => {
    const b = bgmRef.current
    if (b) b.volume = Math.min(1, Math.max(0, project?.bgmVolume ?? 0.15))
  }, [project?.bgmVolume])

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
      if (b) { syncBgm(v.currentTime); void b.play() }
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
  const onTimeUpdate = (sec: number): void => { setCur(sec); onTimeChange?.(Math.round(sec * 1000)) }
  const handlePlay = (): void => { setPlaying(true) }
  const handleStop = (): void => { setPlaying(false); bgmRef.current?.pause() }

  return {
    videoRef, bgmRef, playing, cur, dur, src, bgmSrc, composing, progress,
    toggle, seekTo, onLoadedMeta: setDur, onTimeUpdate, handlePlay, handleStop,
  }
}
