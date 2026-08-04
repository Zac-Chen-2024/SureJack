import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { useProjects } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { IconCheck, IconClose, IconLoader, IconPlay } from '../ui/Icon'
import { OpeningPreview } from './OpeningPreview'

/**
 * 挑开头素材。配音已经在后台跑了，这一屏是拦在烧录【之前】的一道闸。
 *
 * ── 为什么拦在这儿 ──────────────────────────────────────────────────
 * 不拦的话，配音一完成服务端就把片子按随机开头烧掉了（十几分钟），
 * 用户挑完还得再烧一遍，而且他会先看到一条不是自己挑的片子。
 *
 * ── 进度条量的是"够不够"，不是"选了几个" ────────────────────────────
 * 开头段要铺满一个目标时长（跟着配音长度走），所以显示的是"已选 1 分 47 秒 /
 * 目标 2 分 03 秒"。差着也能确认——剩下的自动补，不拦人。
 *
 * ── 「用默认素材」不是"不选" ────────────────────────────────────────
 * 它是把系统现在算出来的那套排布**定下来**。后端会把默认排布物化成一份
 * 具体清单存库，所以按了它之后，重烧多少次都还是这几段。
 *
 * ── ⚠️ 目标时长必须等【配音跑完】才算得出来 ─────────────────────────
 * 开头段铺多长 = 配音总长 × 27%，而进这一屏的时候配音才刚开始跑。
 * 所以这里【不能拿进来那一刻的快照】：要订阅 store、并且在配音没好之前
 * 轮询刷新，等真时长到了再显示进度条。
 * 踩过一次：拿快照 + 没轮询，界面上显示"目标 0 分 04 秒"——那是配音还没
 * 出结果时的空值算出来的，用户照着这个数去挑，挑一段就"满"了。
 */

interface Item { id: string; filename: string; durationMs: number }

/** 开头段占总长的比例。和后端 DEFAULT_RATIO 的第一项一致，改了要两边一起改 */
const OPENING_RATIO = 0.27
const OPENING_BUCKET = '1-开头'

function fmt (ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

export function OpeningPicker ({ ids, onDone }: {
  /** 要挑的项目 id，主片在前、续集在后 */
  ids: string[]
  onDone: () => void
}) {
  // 【订阅】而不是快照：配音跑完时长才会出来，界面必须跟着变
  const all = useProjects((s) => s.items)
  const projects = ids.map((id, at) => {
    const p = all.find((x) => x.id === id)
    return {
      id,
      name: p?.name ?? '',
      ttsState: p?.ttsState ?? 'none',
      ttsDurationMs: p?.ttsDurationMs ?? null,
      isSequel: at > 0,
    }
  })
  const [items, setItems] = useState<Item[] | null>(null)
  const [step, setStep] = useState(0)
  /** 每个项目各自挑的清单，按项目 id 存 */
  const [picks, setPicks] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 「装不下了」的小提示。一闪而过，不占版面 */
  const [tip, setTip] = useState<string | null>(null)

  useEffect(() => {
    void api.get<{ items: Item[] }>(`/api/library/${encodeURIComponent(OPENING_BUCKET)}`)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '素材库读不出来'))
  }, [])

  /*
   * 配音还在跑就每 4 秒刷一次项目。配音一完成，ttsDurationMs 落库，
   * 这一屏的目标时长才有意义。不轮询的话它会一直停在进来那一刻的空值。
   */
  const waitingVoice = projects.some((p) => (p.ttsDurationMs ?? 0) <= 0)
  useEffect(() => {
    if (!waitingVoice) return
    const t = setInterval(() => { void useProjects.getState().load() }, 4000)
    return () => { clearInterval(t) }
  }, [waitingVoice])

  const current = projects[step]
  const pick = current ? picks[current.id] ?? [] : []
  const byId = useMemo(() => new Map((items ?? []).map((it) => [it.id, it])), [items])

  const pickedMs = pick.reduce((sum, id) => sum + (byId.get(id)?.durationMs ?? 0), 0)
  /*
   * 目标时长只对主片有意义：开头段 = 配音总长 × 27%。
   *
   * 【续集不编一个目标出来】。续集那套公式是"几段开头 + 全程跑酷"，
   * 开头段根本没有目标时长——挑几段就是几段，剩下全给跑酷。
   * 硬凑一个"5 段 × 20 秒"的数只会让用户以为有个必须凑满的额度。
   */
  /*
   * 【超出目标时长会发生什么，必须说出来】。后端铺开头段是"铺满就停"：
   * 跨过边界的那一段被截短，再往后的段一个都不用（见 compose/plan.ts
   * 的 fillFrom）。不说的话，用户选了 10 段、烧出来只用了 6 段半，
   * 而且没有任何地方提过——他会以为是 bug。
   *
   * 续集不算：那套公式是"几段开头 + 全程跑酷"，开头段没有上限，
   * 挑几段用几段，剩下的时长自然落给跑酷。
   */
  const durationKnown = (current?.ttsDurationMs ?? 0) > 0
  const targetMs = current === undefined || current.isSequel
    ? 0
    : Math.round((current.ttsDurationMs ?? 0) * OPENING_RATIO)

  /** 逐段累加，算出每一段的下场：整段用、被截短、还是根本用不上 */
  function fateOf (ids: string[], limitMs: number): Array<{ id: string; full: number; take: number }> {
    let acc = 0
    return ids.map((id) => {
      const full = byId.get(id)?.durationMs ?? 0
      const take = limitMs <= 0 ? full : Math.min(full, Math.max(0, limitMs - acc))
      acc += take
      return { id, full, take }
    })
  }

  /*
   * 【装不下就不让加】。后端铺开头段是"铺满就停"：跨过边界的那一段会被
   * 截短、再往后的一段都不用（见 compose/plan.ts 的 fillFrom），而且悄无声息。
   * 与其让用户选了 10 段、烧出来只用了 6 段半，不如当场拦住并说明白。
   *
   * 拦的是【铺满之后】。跨过边界的那一段照样让加——它被截短正好把开头
   * 铺满，是正常且想要的；小条上会如实写成 30→11s。
   * 铺满之后再加进来的才是纯粹用不上的段，那时才封口。
   *
   * ⚠️ 配音还没跑完时目标时长是未知的，这时不设限（否则这一屏在等配音的
   * 几分钟里完全没法用）。等时长到了再开始拦。
   */
  function roomLeftMs (): number {
    if (current === undefined || current.isSequel || !durationKnown) return Number.POSITIVE_INFINITY
    return targetMs - pickedMs
  }

  function toggle (id: string): void {
    if (!current) return
    const now = picks[current.id] ?? []
    const at = now.indexOf(id)
    if (at >= 0) {                       // 取消选择永远允许
      setPicks({ ...picks, [current.id]: now.filter((_, k) => k !== at) })
      return
    }
    if (roomLeftMs() <= 0) {
      setTip('开头已经铺满了，再多就用不上了')
      return
    }
    setPicks({ ...picks, [current.id]: [...now, id] })
  }

  // 提示一闪而过。每次换内容都重新计时，连点几下不会提前消失
  useEffect(() => {
    if (tip === null) return
    const t = setTimeout(() => setTip(null), 2200)
    return () => { clearTimeout(t) }
  }, [tip])

  function remove (at: number): void {
    if (!current) return
    const now = picks[current.id] ?? []
    setPicks({ ...picks, [current.id]: now.filter((_, k) => k !== at) })
  }

  /** 敲定这一集。pick 为空 = 用默认素材（后端会把默认排布物化下来） */
  async function settle (usePick: boolean): Promise<void> {
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/projects/${current.id}/opening`, { pick: usePick ? pick : [] })
      /*
       * 【立刻标成"排队中"】。敲定这一刻队列还没轮到它，/film 回的是
       * state:'none'，编辑器会判成"还没有成片"——把"还没轮到"当成"没有"。
       * 先按在排队显示，等第一次轮询回来再以服务端为准。
       */
      usePipeline.getState().markQueued(current.id)
      if (step + 1 < projects.length) setStep(step + 1)
      else onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '没能保存，再试一次')
    } finally {
      setBusy(false)
    }
  }

  if (current === undefined) return null

  return (
    <div className="absolute inset-0 flex flex-col bg-ink-950" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
      <div className="flex items-center justify-between px-4 pb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-extrabold text-ink-50">挑这一集的开头</h2>
          {/* 预览是"看一眼"，不是主动作——做成标题旁边的小按钮，
              底部那一排只留真正要做决定的两个 */}
          <button
            type="button" onClick={() => setPreviewing(true)} disabled={pick.length === 0}
            aria-label="连着看一遍"
            className="flex size-7 items-center justify-center rounded-full border border-line text-ink-300 transition-colors enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-30"
          >
            <IconPlay className="size-3.5" />
          </button>
        </div>
        <span className="font-mono text-xs text-ink-400">
          {projects.length > 1 ? `第 ${step + 1} 集 / 共 ${projects.length} 集` : current.name}
        </span>
      </div>

      <div className="px-4 pb-2">
        <div className="flex items-baseline justify-between text-xs text-ink-300">
          {/* 显示【实际会播的】总长：最后那段被截短的话，全长和真正播的对不上 */}
          <span>已选 {pick.length} 段 · {fmt(
            !current.isSequel && durationKnown ? Math.min(pickedMs, targetMs) : pickedMs)}</span>
          {current.isSequel
            ? <span className="text-ink-400">默认 5 段，之后直接进跑酷</span>
            : durationKnown
              ? <span className="text-ink-400">目标 {fmt(targetMs)}</span>
              : <span className="flex items-center gap-1 text-ink-400"><IconLoader className="size-3 animate-spin" />配音生成中</span>}
        </div>
        {/* 目标时长要等配音出来才算得准，没出来之前不画进度条——
            画一根按空值算的条，等于给用户一个错的额度 */}
        {!current.isSequel && durationKnown && (
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${targetMs > 0 ? Math.min(100, (pickedMs / targetMs) * 100) : 0}%` }}
            />
          </div>
        )}
        {!current.isSequel && !durationKnown && (
          <p className="mt-1 text-[11px] text-ink-400">
            开头要铺多长是按配音总长算的（27%）。配音还在生成，先挑着，算好了这儿会显示目标。
          </p>
        )}
        {!current.isSequel && durationKnown && pickedMs < targetMs && pick.length > 0 && (
          <p className="mt-1 text-[11px] text-ink-400">还差 {fmt(targetMs - pickedMs)}，不补满也行，剩下的自动接。</p>
        )}
        {/* 铺满之后就不让再加了，所以这里只可能是"最后那段被截短"这一种情况 */}
        {!current.isSequel && durationKnown && pickedMs >= targetMs && (
          <p className="mt-1 text-[11px] text-accent">开头铺满了。最后那段会截到正好接上，多的部分不播。</p>
        )}
      </div>

      {/* 已选的一排：顺序就是播放顺序 */}
      {pick.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-2">
          {fateOf(pick, current.isSequel ? 0 : targetMs).map((f, at) => {
            const unused = f.take === 0
            const cut = f.take > 0 && f.take < f.full
            return (
              <button
                key={`${f.id}-${at}`} type="button" onClick={() => remove(at)}
                title={unused ? '超出开头时长，这段用不上' : cut ? '这段会被截短' : ''}
                className={`flex flex-none items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] ${
                  unused
                    ? 'border-line bg-ink-850 text-ink-500 line-through'
                    : 'border-accent/60 bg-accent/10 text-accent'}`}
              >
                {at + 1} · {cut
                  ? `${Math.round(f.full / 1000)}→${Math.round(f.take / 1000)}s`
                  : `${Math.round(f.full / 1000)}s`}
                <IconClose className="size-3" />
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {items === null && <div className="flex justify-center py-10 text-ink-400"><IconLoader className="size-5 animate-spin" /></div>}
        <div className="grid grid-cols-3 gap-1.5">
          {(items ?? []).map((it) => {
            const n = pick.filter((p) => p === it.id).length
            // 铺满之后其余的一律变暗：不用点一下才知道加不进去了
            const tooBig = n === 0 && roomLeftMs() <= 0
            return (
              <button
                key={it.id} type="button" onClick={() => toggle(it.id)}
                className={`relative aspect-[9/16] overflow-hidden rounded-md border transition-opacity ${
                  n > 0 ? 'border-accent' : 'border-line'} ${tooBig ? 'opacity-30' : ''}`}
              >
                <img
                  src={`/api/library/items/${it.id}/thumb`} alt=""
                  loading="lazy" className="size-full object-cover"
                />
                {n > 0 && (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent font-mono text-[10px] font-bold text-ink-950">
                    {n > 1 ? n : <IconCheck className="size-3" strokeWidth={3} />}
                  </span>
                )}
                <span className="absolute bottom-0 left-0 right-0 bg-black/55 py-0.5 text-center font-mono text-[10px] text-white">
                  {Math.round(it.durationMs / 1000)}s
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {error !== null && <p className="px-4 pb-1 text-center text-[11px] text-accent">{error}</p>}

      <div
        className="flex gap-2 border-t border-line bg-ink-900 px-4 pb-[env(safe-area-inset-bottom,0px)] pt-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
      >
        <button
          type="button" onClick={() => void settle(false)} disabled={busy}
          className="flex-1 rounded-xl border border-line px-3 py-3 text-sm font-bold text-ink-300 disabled:opacity-40"
        >
          用默认素材
        </button>
        <button
          type="button" onClick={() => void settle(true)} disabled={busy || pick.length === 0}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-3 text-sm font-extrabold text-ink-950 disabled:opacity-40"
        >
          {busy ? <IconLoader className="size-4 animate-spin" /> : <IconCheck className="size-4" strokeWidth={2.6} />}
          {step + 1 < projects.length ? '下一集' : '开始合成'}
        </button>
      </div>

      {tip !== null && (
        <div
          role="status"
          className="sj-motion pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-6"
        >
          <span className="rounded-full border border-accent/50 bg-ink-850/95 px-3.5 py-2 text-xs font-bold text-accent shadow-lg">
            {tip}
          </span>
        </div>
      )}

      {previewing && <OpeningPreview itemIds={pick} onClose={() => setPreviewing(false)} />}
    </div>
  )
}
