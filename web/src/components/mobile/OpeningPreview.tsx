import { useEffect, useRef, useState } from 'react'

/**
 * 把挑好的开头素材【连着播一遍】。
 *
 * ── 这不是"先拼一条片子出来" ────────────────────────────────────────
 * 服务器上不生成任何文件：不拼接、不转码、不留临时片子。就是一个播放器
 * 按顺序放——第一段播完自动接第二段。用户要的原话是"相当于连续播放"。
 *
 * ── 画面上只有素材本身 ──────────────────────────────────────────────
 * 没有字幕、标题、水印、免责声明。那些是烧录那一步才加的，这里加上反而
 * 会让人以为成片就长这样。所以连播放进度条都不画，点一下就退出。
 *
 * ── 双缓冲：接缝不能黑一下 ──────────────────────────────────────────
 * 两个 video 轮换：正在放 A 的时候，B 已经把下一段加载好并且定位到位，
 * 到点直接换。单个 video 改 src 的话，每次换段都要重新走一遍
 * "请求→缓冲→起播"，五六段就是五六次黑屏转圈——那样根本看不出接得顺不顺。
 *
 * ── 按 9:16 裁着显示 ────────────────────────────────────────────────
 * 素材画幅不一，成片会统一裁成竖屏。按原始画幅放的话，挑的时候看着好，
 * 烧出来两边被切掉。裁法（object-cover）和成片一致。
 */
export function OpeningPreview ({ itemIds, onClose }: {
  itemIds: string[]
  onClose: () => void
}) {
  const a = useRef<HTMLVideoElement>(null)
  const b = useRef<HTMLVideoElement>(null)
  /** 当前在放第几段 */
  const [i, setI] = useState(0)
  /** 当前用的是哪个 video。换段就翻面 */
  const [front, setFront] = useState<'a' | 'b'>('a')

  const src = (id: string): string => `/api/library/items/${id}`

  // 起播：把第 0 段放进 A，第 1 段预载进 B
  useEffect(() => {
    const va = a.current
    const vb = b.current
    if (!va || !vb || itemIds.length === 0) return
    va.src = src(itemIds[0]!)
    void va.play().catch(() => { /* 用户没交互过时浏览器会拒播，静音后一般不会 */ })
    if (itemIds[1] !== undefined) vb.src = src(itemIds[1]!)
  }, [itemIds])

  /** 当前这段播完 → 翻到已经准备好的那一面，同时把再下一段预载进刚空出来的 */
  function onEnded (): void {
    const next = i + 1
    if (next >= itemIds.length) { onClose(); return }
    const showing = front === 'a' ? b.current : a.current
    const freed = front === 'a' ? a.current : b.current
    setFront(front === 'a' ? 'b' : 'a')
    setI(next)
    void showing?.play().catch(() => { /* 同上 */ })
    const after = itemIds[next + 1]
    if (freed && after !== undefined) freed.src = src(after)
  }

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('keydown', esc) }
  }, [onClose])

  const cls = (mine: 'a' | 'b'): string =>
    `absolute inset-0 size-full object-cover ${front === mine ? 'opacity-100' : 'opacity-0'}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={onClose}
      role="button"
      tabIndex={0}
      aria-label="退出预览"
      onKeyDown={(e) => { if (e.key === 'Enter') onClose() }}
    >
      <div className="relative aspect-[9/16] max-h-full w-full max-w-[min(100vw,56vh)] overflow-hidden">
        {/* muted 是必须的：手机浏览器不允许带声自动播放。开头素材的原声在成片里
            本来也一律丢掉（只留配音），这里静音正好和成片一致 */}
        <video ref={a} className={cls('a')} muted playsInline onEnded={onEnded} />
        <video ref={b} className={cls('b')} muted playsInline onEnded={onEnded} />
      </div>
    </div>
  )
}
