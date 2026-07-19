import { useEffect, useRef, useState } from 'react'
import {
  useProjects, maxSubtitleMarginV, subtitleHeightLabel, DEFAULT_SUBTITLE_MARGIN_V,
  MIN_SUBTITLE_MARGIN_V,
} from '../store/projects'
import { IconSubtitles } from './ui/Icon'

/** 落库前的静默期。见下面对防抖的说明 */
const DEBOUNCE_MS = 250

/**
 * 字幕高度滑块。
 *
 * ── 为什么它挨着预览，而不在字幕列表旁边 ──────────────────────────────
 * 字幕列表在中栏，预览在右栏。但这个参数是**看着画面调的**——用户要看的
 * 是"字幕有没有压在人脸上"，而不是某一行的文字内容。放在预览正下方，
 * 眼睛不用离开画面就能拖；放到字幕列表旁边，每拖一下都要横跨半个屏幕
 * 去确认效果。所以它跟着"出来什么"这一栏走。
 *
 * ── 预览为什么会自己跟上 ────────────────────────────────────────────
 * 不需要任何额外的预览逻辑：落库后后端回的整条项目带着新的 updatedAt，
 * Preview 的 ASS 拉取 effect 依赖它，于是重新 GET subtitles.ass；而
 * ffmpeg 烧录读的是**同一个 buildAssForProject** 的产物。这就是本项目
 * 「预览即成片」的架构保证，别在这儿另画一套 DOM 字幕去"模拟"位置。
 *
 * ── 为什么要防抖 ────────────────────────────────────────────────────
 * 滑块每移动 1px 就是一次 onChange。不防抖的话一次拖动能打出上百个
 * PATCH，每个 PATCH 又触发一次 ASS 重取 + JASSUB 重建（销毁 worker、
 * 重新加载 wasm）——预览会直接卡死。所以【本地状态立刻跟手、落库防抖】。
 *
 * ── 为什么不显示像素数 ──────────────────────────────────────────────
 * 用户关心的是"压不压脸"，不是 300 还是 640。报一个数字只会让人以为
 * 那个数本身有意义，然后开始纠结它。给相对说法就够了。
 */
export function SubtitleHeight () {
  const project = useProjects((s) => s.current())
  const setSubtitleMarginV = useProjects((s) => s.setSubtitleMarginV)

  const max = maxSubtitleMarginV(project?.aspectRatio ?? '9:16')
  const stored = project?.subtitleMarginV ?? DEFAULT_SUBTITLE_MARGIN_V
  const [value, setValue] = useState(stored)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 切项目时把滑块拉回那个项目自己的值。这个组件在项目之间是复用的、
  // 不重挂，所以不能只在挂载时取初值。
  useEffect(() => { setValue(stored) }, [project?.id, stored])

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  function onChange (next: number) {
    setValue(next)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void setSubtitleMarginV(next) }, DEBOUNCE_MS)
  }

  if (!project) return null

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconSubtitles className="size-3.5" />字幕高度
        <span className="ml-auto normal-case">{subtitleHeightLabel(value, max)}</span>
      </div>
      <input
        type="range"
        min={MIN_SUBTITLE_MARGIN_V} max={max} step={10}
        value={Math.min(value, max)}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="字幕高度"
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700"
        style={{ accentColor: 'var(--color-accent)' }}
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
        字幕在画面里的高低。背景里的人脸位置不一样，往上挪一点常常更好看。
      </p>
    </div>
  )
}
