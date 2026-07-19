import { useState } from 'react'
import {
  useProjects, maxSubtitleMarginV, subtitleHeightLabel, DEFAULT_SUBTITLE_MARGIN_V,
  MIN_SUBTITLE_MARGIN_V, DEFAULT_SUBTITLE_FONT_SIZE,
  MIN_SUBTITLE_FONT_SIZE, MAX_SUBTITLE_FONT_SIZE,
} from '../store/projects'
import { IconSubtitles } from './ui/Icon'

/**
 * 字幕高度滑块。
 *
 * ── 拖动【不落库】，确认才重烧 ──────────────────────────────────────
 * 改字幕高度会改 ASS，进而让母带指纹失效——那是十几分钟的重烧。所以
 * 拖动期间只有前端在动：滑块改草稿值，预览画面上画一条示意字幕跟着走，
 * 用户看着它找位置。直到点「确认」才落库，才真的重烧一次。
 *
 * 【为什么不能"防抖之后自动落库"】。以前就是那么做的（250ms 防抖），
 * 问题不在请求数量，在于每一次落库都会让手上那条能播的成片作废、
 * 排一条十几分钟的渲染。用户在滑块上来回找位置的十几秒里能排出十几条，
 * 而他其实只想要最后那一个值。防抖只是把"太多次"变成"少几次"，
 * 没有解决"他还没想好就已经开始重烧了"。
 *
 * ── 为什么示意字幕够用 ──────────────────────────────────────────────
 * MarginV 是 ASS 里以 PlayRes（1080×1920）为单位的底边距，换算成
 * 画面高度的百分比就能在 DOM 里摆到同一个位置。字体大小和描边不必
 * 完全一致——用户此刻要判断的是"压不压脸"，那只跟纵向位置有关。
 */
export function SubtitleHeight () {
  const project = useProjects((s) => s.current())
  const commit = useProjects((s) => s.commitSubtitleDraft)
  const draftMargin = useProjects((s) => s.draftMarginV)
  const setDraftMargin = useProjects((s) => s.setDraftMarginV)
  const draftSize = useProjects((s) => s.draftFontSize)
  const setDraftSize = useProjects((s) => s.setDraftFontSize)
  const [busy, setBusy] = useState(false)

  const max = maxSubtitleMarginV(project?.aspectRatio ?? '9:16')
  const storedMargin = project?.subtitleMarginV ?? DEFAULT_SUBTITLE_MARGIN_V
  const storedSize = project?.subtitleFontSize ?? DEFAULT_SUBTITLE_FONT_SIZE
  const margin = draftMargin ?? storedMargin
  const size = draftSize ?? storedSize
  const dirty = (draftMargin !== null && draftMargin !== storedMargin)
    || (draftSize !== null && draftSize !== storedSize)

  if (!project) return null

  async function onConfirm () {
    setBusy(true)
    // 落库失败时【不清草稿】，让用户的改动还留在滑块上，可以直接重试
    try { await commit() } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconSubtitles className="size-3.5" />字幕
      </div>

      <label className="mb-1 flex items-baseline justify-between text-[11px] text-ink-400">
        <span>高度</span>
        <span>{subtitleHeightLabel(margin, max)}</span>
      </label>
      <input
        type="range"
        min={MIN_SUBTITLE_MARGIN_V} max={max} step={10}
        value={Math.min(margin, max)}
        onChange={(e) => setDraftMargin(Number(e.target.value))}
        aria-label="字幕高度"
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700"
        style={{ accentColor: 'var(--color-accent)' }}
      />

      <label className="mb-1 mt-3 flex items-baseline justify-between text-[11px] text-ink-400">
        <span>字号</span>
        <span className="tabular-nums">{size}</span>
      </label>
      <input
        type="range"
        min={MIN_SUBTITLE_FONT_SIZE} max={MAX_SUBTITLE_FONT_SIZE} step={2}
        value={size}
        onChange={(e) => setDraftSize(Number(e.target.value))}
        aria-label="字幕字号"
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700"
        style={{ accentColor: 'var(--color-accent)' }}
      />

      {dirty ? (
        <div className="mt-3">
          {/*
            【把代价说出来再让他点】。确认下去就是十几分钟的重烧，
            而这件事从"拖了一下滑块"完全看不出来。
          */}
          <p className="mb-2 text-[11px] leading-relaxed text-ink-400">
            预览里那行黄字就是字幕的位置和大小。确认后要重新合成一遍，
            大约十几分钟；这期间现在这条片子照常能看能下。
          </p>
          <div className="flex gap-2">
            <button
              type="button" onClick={() => void onConfirm()} disabled={busy}
              className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-50"
            >
              {busy ? '提交中…' : '确认，重新合成'}
            </button>
            <button
              type="button"
              onClick={() => { setDraftMargin(null); setDraftSize(null) }}
              disabled={busy}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-300 transition-colors hover:text-ink-50 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          字幕在画面里的高低和大小。背景里的人脸位置不一样，往上挪一点常常更好看。
        </p>
      )}
    </div>
  )
}
