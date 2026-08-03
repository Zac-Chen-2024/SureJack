import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useProjects, DEFAULT_WATERMARK, type Project } from '../../store/projects'
import { IconCheck, IconLoader } from '../ui/Icon'

/**
 * 生成之前定标题：每条片子两个，主片和续集分开填。
 *
 * ── 为什么在这一步、而不是丢进设置里 ────────────────────────────────
 * 封面标题和片内标题都会被【烧进产物】：封面是最前面那两帧，片内是顶部
 * 常驻那行。生成之后再改，前者要重拼一次成片、后者要整条重烧十几分钟。
 * 所以这两个字段的正确位置就是"按下生成之前的最后一屏"。
 *
 * ── 水印也在这一屏 ──────────────────────────────────────────────────
 * 同一个理由：它逐帧烧在画面上，生成之后再改要整条重烧。它对两集是
 * 同一个值（同一个号），所以只填一次，不像标题那样每集一个。
 *
 * ── 三个标题是三件事 ────────────────────────────────────────────────
 *   项目名     只给作者自己看（列表、文件夹名），观众永远看不到
 *   封面标题   平台抓缩略图那一帧上的字，决定别人点不点进来
 *   片内标题   看片的人全程都在看的那行
 * 所以默认值可以互相推，但字段必须各自独立——很多时候封面写钩子、
 * 片内写剧名，本来就该不一样。
 *
 * ── 一键应用 ────────────────────────────────────────────────────────
 * 「用项目名做标题」把项目名铺到四个格子里，续集自动加「2」。
 * 这只是一次性写值，之后改哪个都不会被它覆盖回去。
 */

/** 一条片子的两个标题 */
function TitleRow ({ p, index }: { p: Project; index: number }) {
  const patch = useProjects((s) => s.patchProject)
  const select = useProjects((s) => s.select)
  const [cover, setCover] = useState(p.coverTitle ?? '')
  const [inVideo, setInVideo] = useState(p.inVideoTitle ?? '')
  const [saved, setSaved] = useState(false)

  // 一键应用之后库里的值变了，把输入框同步过来
  useEffect(() => { setCover(p.coverTitle ?? '') }, [p.coverTitle])
  useEffect(() => { setInVideo(p.inVideoTitle ?? '') }, [p.inVideoTitle])

  /*
   * 【失焦才写库】。每敲一个字就发一次 PATCH 没有必要，而且 patchProject
   * 作用在"当前选中项目"上——两条片子轮流写的话，每次都要先切选中态，
   * 打字过程中来回切会把别的面板也跟着晃。
   */
  async function commit (patchOne: { coverTitle?: string; inVideoTitle?: string }) {
    const before = useProjects.getState().currentId
    if (before !== p.id) select(p.id)
    await patch(patchOne)
    if (before && before !== p.id) select(before)
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-bold text-ink-300">
          第 {index} 集
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink-50">{p.name}</span>
        {saved && <IconCheck className="size-3.5 shrink-0 text-accent" />}
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-400">封面标题（缩略图那一帧上的字）</span>
        <input
          value={cover}
          onChange={(e) => setCover(e.target.value.slice(0, 20))}
          onBlur={() => { if ((cover.trim()) !== (p.coverTitle ?? '').trim()) void commit({ coverTitle: cover.trim() }) }}
          placeholder={p.name}
          className="w-full rounded-lg border border-line bg-ink-800 px-2.5 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-400">片内标题（画面顶部常驻）</span>
        <input
          value={inVideo}
          onChange={(e) => setInVideo(e.target.value.slice(0, 20))}
          onBlur={() => { if ((inVideo.trim()) !== (p.inVideoTitle ?? '').trim()) void commit({ inVideoTitle: inVideo.trim() }) }}
          placeholder={p.name}
          className="w-full rounded-lg border border-line bg-ink-800 px-2.5 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
        />
      </label>
    </div>
  )
}

/**
 * 水印文字。两集共用一个值——它是号的标识，不是这条片子的标题。
 *
 * 【默认沿用上一次用过的】。做水印那次留了"文字用什么"没定，结果新项目
 * 一律是空的、水印那套代码等于没生效。而这个值对同一个号是长期不变的，
 * 每次重填一遍纯属折腾——所以从这个人已有的项目里取最近用过的那个。
 */
function WatermarkRow ({ list }: { list: Project[] }) {
  const items = useProjects((s) => s.items)
  const patch = useProjects((s) => s.patchProject)
  const select = useProjects((s) => s.select)
  /*
   * 默认值：先用这个人上一次用过的（换号的人不用每次重填），
   * 一次都没用过就落到 DEFAULT_WATERMARK。前后端各存一份、由测试钉住一致，
   * 和字号那几个常量同一个套路（前端不能 import 后端）。
   */
  const lastUsed = items.find((p) => (p.watermarkText ?? '') !== '')?.watermarkText ?? DEFAULT_WATERMARK
  const current = list.find((p) => (p.watermarkText ?? '') !== '')?.watermarkText ?? ''
  const [text, setText] = useState(current || lastUsed)
  const [saved, setSaved] = useState(false)

  // 进来时如果库里还没写过，把"上次用过的"落到这两条项目上
  useEffect(() => {
    if (current === '' && text !== '') void commit(text)
    // 只在挂载时铺一次，之后以输入框为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function commit (value: string) {
    const before = useProjects.getState().currentId
    for (const p of list) {
      if ((p.watermarkText ?? '') === value) continue
      select(p.id)
      await patch({ watermarkText: value })
    }
    if (before) select(before)
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-ink-50">水印</span>
        <span className="text-[11px] text-ink-500">两集共用 · 留空就不打</span>
        {saved && <IconCheck className="ml-auto size-3.5 shrink-0 text-accent" />}
      </div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 8))}
        onBlur={() => { if (text.trim() !== current) void commit(text.trim()) }}
        placeholder="不打水印"
        className="w-full rounded-lg border border-line bg-ink-800 px-2.5 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-600"
      />
      <p className="text-[11px] leading-relaxed text-ink-500">
        半透明小字，在六个角之间匀速移动（1 分半、3 分、6 分、9 分各换一处）。
      </p>
    </div>
  )
}

export function EpisodeTitles ({ ids }: { ids: string[] }) {
  const items = useProjects((s) => s.items)
  const reload = useProjects((s) => s.load)
  const [busy, setBusy] = useState(false)
  const list = ids.map((id) => items.find((p) => p.id === id)).filter(Boolean) as Project[]
  if (list.length === 0) return null

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold text-ink-50">标题</h3>
        <span className="text-[11px] text-ink-500">留空就用项目名</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              // 站在主片上调一次，后端会把续集的也一起铺好（加「2」）
              await api.post(`/api/projects/${ids[0]}/titles/apply-name`)
              await reload()
            } finally { setBusy(false) }
          }}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[11px] font-medium text-ink-200 disabled:opacity-50"
        >
          {busy ? <IconLoader className="size-3 animate-spin" /> : null}
          用项目名做标题
        </button>
      </div>

      {list.map((p) => <TitleRow key={p.id} p={p} index={p.episodeIndex} />)}

      <WatermarkRow list={list} />

      {/* 这两个字段会被烧进产物，生成之后再改代价完全不同——说清楚 */}
      <p className="text-[11px] leading-relaxed text-ink-500">
        封面标题改起来便宜（重拼几秒）；片内标题烧在画面里，生成之后再改要
        整条重合成。趁现在定好。
      </p>
    </section>
  )
}
