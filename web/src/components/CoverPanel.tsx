import { useState } from 'react'
import { useProjects } from '../store/projects'
import { IconFrame } from './ui/Icon'
import { ApplyNameButton } from './mobile/SplitPicker'

/**
 * 封面标题。
 *
 * 成片最前面会插两帧「封面图 + 这行标题」——平台抓缩略图默认取第一帧，
 * 于是列表页展示的是我们设计过的封面，而不是正片随机的第一帧。
 * 两帧 @30fps 只有 0.067 秒，观众几乎察觉不到。
 *
 * ── 改标题很便宜，但仍然要点确认 ────────────────────────────────────
 * 它只进【成片指纹】，不进母带指纹：改了只重跑几秒的封面渲染 + 拼接，
 * 十几分钟的烧录一秒都不会重来。即便如此也不做"输入即落库"——每敲一个字
 * 就重排一条合成，用户打字打到一半的半截标题会被真的合进片子里。
 *
 * ── 版式不给调 ──────────────────────────────────────────────────────
 * 字体/字号/描边/位置是照着参考图逐像素拟合出来的（见 src/cover/cover.ts
 * 顶部那段），是这个封面样式的全部定义。开放成可调项，等于让用户去破坏
 * 那个已经对齐的结果，而他并不知道自己在破坏什么。
 */
export function CoverPanel () {
  const project = useProjects((s) => s.current())
  const patch = useProjects((s) => s.patchProject)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!project) return null

  const stored = project.coverTitle ?? ''
  const value = draft ?? stored
  // 空 = 跟着项目名走，所以占位符要把这件事说出来，别让人以为是"没封面"
  const effective = value.trim() === '' ? project.name : value.trim()
  const dirty = value.trim() !== stored.trim()

  async function save () {
    setBusy(true)
    try {
      await patch({ coverTitle: value.trim() })
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <IconFrame className="size-4 text-ink-400" />
        <h3 className="text-sm font-bold text-ink-50">标题</h3>
        {/* 一键把项目名铺到两个标题上；有续集的话自动加「2」 */}
        <span className="ml-auto"><ApplyNameButton projectId={project.id} onDone={() => setDraft(null)} /></span>
      </div>

      {/* 预览：底图 + 标题，比例和成片一致（9:16），字号按同一个比例缩 */}
      <div className="flex items-start gap-3">
        <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-lg border border-line">
          <img src="/api/cover/preview.jpg" alt="" className="absolute inset-0 size-full object-cover" />
          <span
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-1 text-center font-bold leading-tight text-white"
            style={{
              // 0.16508 是拟合出来的字号/画布宽比例；96px 宽 → 约 16px
              fontSize: 'calc(96px * 0.16508)',
              WebkitTextStroke: 'calc(96px * 0.16508 * 0.0386) black',
              paintOrder: 'stroke fill',
            }}
          >
            {effective}
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <input
            value={value}
            onChange={(e) => setDraft(e.target.value.slice(0, 20))}
            placeholder={project.name}
            className="w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
          />
          <p className="text-[11px] leading-relaxed text-ink-400">
            留空就用项目名。最多 20 字——再长在画面上会挤成看不清的一条。
          </p>
          {dirty && (
            <div className="flex gap-2">
              <button
                type="button" disabled={busy} onClick={() => void save()}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-ink-950 disabled:opacity-50"
              >
                {busy ? '保存中…' : '确认'}
              </button>
              <button
                type="button" disabled={busy} onClick={() => setDraft(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-300 disabled:opacity-50"
              >
                取消
              </button>
            </div>
          )}
          {dirty && (
            <p className="text-[11px] leading-relaxed text-ink-500">
              确认后会重做封面并重新拼一次成片，几秒钟；正片不会重烧。
            </p>
          )}
        </div>
      </div>

      <InVideoTitleRow />
    </section>
  )
}

/**
 * 片内标题——顶部常驻那行大字。
 *
 * 【和封面标题分开】：封面是给平台抓缩略图看的一帧，片内是看片的人全程
 * 都在看的那行。作者会想给它们写不一样的话（封面写钩子、片内写剧名），
 * 所以它们是两个字段，不是一个字段两处用。
 *
 * ⚠️ 改它【会重烧母带】——它写在 ASS 里，ASS 进母带指纹。所以这一栏的
 * 代价提示和封面那栏完全不同，别把两句话写成一样的。
 */
function InVideoTitleRow () {
  const project = useProjects((s) => s.current())
  const patch = useProjects((s) => s.patchProject)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!project) return null

  const stored = project.inVideoTitle ?? ''
  const value = draft ?? stored
  const dirty = value.trim() !== stored.trim()

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h3 className="text-sm font-bold text-ink-50">片内标题</h3>
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value.slice(0, 20))}
        placeholder={project.name}
        className="w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
      />
      <p className="text-[11px] leading-relaxed text-ink-400">
        画面顶部常驻的那行字，留空就用项目名。
      </p>
      {dirty && (
        <>
          <div className="flex gap-2">
            <button
              type="button" disabled={busy}
              onClick={async () => {
                setBusy(true)
                try { await patch({ inVideoTitle: value.trim() }); setDraft(null) } finally { setBusy(false) }
              }}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-ink-950 disabled:opacity-50"
            >
              {busy ? '保存中…' : '确认'}
            </button>
            <button
              type="button" disabled={busy} onClick={() => setDraft(null)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-300 disabled:opacity-50"
            >
              取消
            </button>
          </div>
          {/* 这行字烧在画面上，改它要整条重烧——代价和封面完全不是一个量级 */}
          <p className="text-[11px] leading-relaxed text-[#e0a82e]">
            片内标题烧在画面里，确认后要重新合成整条视频（十几分钟）。
          </p>
        </>
      )}
    </div>
  )
}
