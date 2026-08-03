import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { IconLoader, IconScissors, IconCheck } from '../ui/Icon'

/**
 * 分集断点选择器——**滚轮**。
 *
 * ── 为什么是滚轮而不是输入框/滑块 ──────────────────────────────────
 * 用户要选的是"切在哪一句"，而判断依据是那句话本身写了什么。滑块只能给
 * 一个数字，输入框要他先知道句号；滚轮把句子直接摆在眼前，滚到哪儿看到
 * 哪儿，选中的那句在正中间高亮——这和他脑子里"翻到那一段"的动作是同一个。
 *
 * ── 每一格都带估算时长 ──────────────────────────────────────────────
 * 切在这里主片有多长，是他做决定的另一半依据。时长【不是模型报的】，
 * 是后端按字数算的（见 episodes/sentences.ts），所以可复算、可解释。
 *
 * ── AI 的候选是快捷键，不是答案 ────────────────────────────────────
 * 上面几颗按钮一点就滚过去，附带一句"为什么这里断"。用户可以采纳，也可以
 * 无视它自己滚——最终以他确认的为准。
 */

interface Sentence { index: number; text: string; cumulativeMs: number }
interface Candidate { sentenceIndex: number; reason: string; estimatedMs: number }
interface Plan {
  sentences: Sentence[]
  candidates: Candidate[]
  introEndIndex: number
  introReason: string
  allowed: { min: number; max: number }
  totalMs: number
  reminderPreview: string
}

const ROW = 56          // 每格高度，和下面的 style 保持一致
const VISIBLE = 5       // 露出几格；正中间那格是选中项

function fmt (ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

/** 一个滚轮。选中项永远在正中间那一格 */
function Wheel ({ items, value, onChange, allowed }: {
  items: Sentence[]
  value: number
  onChange: (index: number) => void
  allowed?: { min: number; max: number }
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const programmatic = useRef(false)

  /*
   * 外部改了选中项（点候选按钮、切页签）→ 滚过去。
   *
   * ⚠️【解锁必须按"到位"，不能按时间】。原来是 setTimeout 400ms 解锁，
   * 而平滑滚动的时长取决于距离：从第 5 句滚到第 200 句要滚一万多像素，
   * 远不止 400ms。锁提前放开，剩下那段【还在自己滚】的过程就被当成了
   * 用户在拨滚轮，于是把中间值回调出去——断点被冲成个位数。
   *
   * 真实后果：主片只剩 12 秒（第 5 句），整篇 5900 字全掉进续集。
   * 用户看到的症状是挑开头那一屏显示"目标 0 分 04 秒"。
   *
   * 现在：到位（或滚动停下）才解锁，另有 3 秒兜底防止永远锁死。
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target = value * ROW
    programmatic.current = true
    el.scrollTo({ top: target, behavior: 'smooth' })

    let done = false
    const unlock = (): void => {
      if (done) return
      done = true
      programmatic.current = false
      el.removeEventListener('scrollend', unlock)
      clearInterval(poll)
      clearTimeout(bail)
    }
    // scrollend 是最准的信号；老 WebView 没有就靠轮询"到位了没"
    el.addEventListener('scrollend', unlock)
    const poll = setInterval(() => {
      if (Math.abs(el.scrollTop - target) <= 2) unlock()
    }, 100)
    // 兜底：万一两个信号都没来（元素被隐藏之类），别让滚轮永远失灵
    const bail = setTimeout(unlock, 3000)
    return unlock
  }, [value])

  return (
    <div className="relative">
      {/* 正中那一格的框：滚轮的"读数窗口" */}
      <div
        className="pointer-events-none absolute inset-x-0 z-10 rounded-xl border-2 border-accent/70"
        style={{ top: ROW * Math.floor(VISIBLE / 2), height: ROW }}
      />
      <div
        ref={ref}
        onScroll={() => {
          if (programmatic.current) return
          // 【停下来再上报】。滚动途中每帧都上报的话，父组件每帧重渲染，
          // 手指还没松手滚轮就开始卡顿
          if (settle.current) clearTimeout(settle.current)
          settle.current = setTimeout(() => {
            const el = ref.current
            if (!el) return
            const i = Math.round(el.scrollTop / ROW)
            const clamped = Math.min(items.length - 1, Math.max(0, i))
            if (clamped !== value) onChange(clamped)
          }, 120)
        }}
        className="relative overflow-y-auto overscroll-contain"
        style={{
          height: ROW * VISIBLE,
          scrollSnapType: 'y mandatory',
          // 上下各垫半个窗口，第一句和最后一句也能滚到正中间
          paddingTop: ROW * Math.floor(VISIBLE / 2),
          paddingBottom: ROW * Math.floor(VISIBLE / 2),
          maskImage: 'linear-gradient(180deg,transparent,#000 22%,#000 78%,transparent)',
        }}
      >
        {items.map((s) => {
          const outside = allowed && (s.index < allowed.min || s.index > allowed.max)
          return (
            <div
              key={s.index}
              style={{ height: ROW, scrollSnapAlign: 'start' }}
              className={`flex items-center gap-2.5 px-3 ${
                s.index === value ? 'text-ink-50' : outside ? 'text-ink-600' : 'text-ink-400'
              }`}
            >
              <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-ink-600">
                {s.index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{s.text}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-600">
                {fmt(s.cumulativeMs)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SplitPicker ({ projectId, onDone, onCancel }: {
  projectId: string
  /** 拆完把两条片子的 id 交回去——下一步要给它们分别填标题 */
  onDone: (ids: { mainId: string; sequelId: string }) => void
  onCancel: () => void
}) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [breakIndex, setBreakIndex] = useState(0)
  const [introEnd, setIntroEnd] = useState(0)
  const [tab, setTab] = useState<'break' | 'intro'>('break')
  const [busy, setBusy] = useState(false)

  async function load () {
    setLoading(true); setError(null)
    try {
      const p = await api.get<Plan>(`/api/projects/${projectId}/split/plan`)
      setPlan(p)
      setBreakIndex(p.candidates[0]?.sentenceIndex ?? Math.floor(p.sentences.length / 2))
      setIntroEnd(p.introEndIndex)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [projectId])

  const mainMs = useMemo(
    () => plan?.sentences[breakIndex]?.cumulativeMs ?? 0, [plan, breakIndex])
  const sequelMs = Math.max(0, (plan?.totalMs ?? 0) - mainMs
    + (plan?.sentences[introEnd]?.cumulativeMs ?? 0))

  async function confirm () {
    setBusy(true)
    try {
      const r = await api.post<{ main: { id: string }; sequel: { id: string } }>(
        `/api/projects/${projectId}/split`, { breakIndex, introEndIndex: introEnd })
      onDone({ mainId: r.main.id, sequelId: r.sequel.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2.5 py-10">
        <IconLoader className="size-6 animate-spin text-accent" />
        <p className="text-xs text-ink-400">AI 正在找悬念点…</p>
      </div>
    )
  }

  if (error && !plan) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-danger">{error}</p>
        {/* 每个调 AI 的地方都要有重试——网络抖一下不该让人从头再来 */}
        <button
          type="button" onClick={() => void load()}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-ink-950"
        >
          重试
        </button>
      </div>
    )
  }
  if (!plan) return null

  const items = tab === 'break' ? plan.sentences : plan.sentences.slice(0, Math.max(1, breakIndex))
  const value = tab === 'break' ? breakIndex : Math.min(introEnd, Math.max(0, breakIndex - 1))

  return (
    <div className="space-y-3.5">
      {/* 两个滚轮共用一个窗口，用页签切——同屏摆两个滚轮，手指会误滚另一个 */}
      <div className="flex gap-1.5 rounded-xl bg-ink-850 p-1">
        {([['break', '主片断点'], ['intro', '引子到哪儿']] as const).map(([k, label]) => (
          <button
            key={k} type="button" onClick={() => setTab(k)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-bold transition-colors ${
              tab === k ? 'bg-ink-700 text-ink-50' : 'text-ink-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        * 引子那一页：把 AI 的判断依据摆出来。它找的是"钩子段落和正文第一个
        * 场景的交界"，理由通常是「出现具体时间状语『晚膳时』」这种——
        * 用户看一眼就知道该不该信，比一个光秃秃的推荐值有用得多。
        */}
      {tab === 'intro' && (
        <div className="rounded-xl border border-line bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-ink-300">
          <span className="font-bold text-ink-100">AI 的判断：</span>{plan.introReason}
          <span className="mt-1 block text-ink-500">
            引子是开篇那段钩子，收在正文第一个场景之前。觉得不对就滚轮自己挪。
          </span>
        </div>
      )}

      {tab === 'break' && (
        <div className="flex flex-wrap gap-1.5">
          {plan.candidates.map((c) => (
            <button
              key={c.sentenceIndex}
              type="button"
              onClick={() => setBreakIndex(c.sentenceIndex)}
              title={c.reason}
              className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                breakIndex === c.sentenceIndex
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-line bg-ink-850 text-ink-300'
              }`}
            >
              <span className="block font-bold">{fmt(c.estimatedMs)}</span>
              <span className="block max-w-[9rem] truncate text-ink-400">{c.reason}</span>
            </button>
          ))}
        </div>
      )}

      <Wheel
        items={items}
        value={value}
        onChange={(i) => (tab === 'break' ? setBreakIndex(i) : setIntroEnd(i))}
        allowed={tab === 'break' ? plan.allowed : undefined}
      />

      <div className="rounded-xl border border-line bg-ink-900 p-3 text-[11px] leading-relaxed text-ink-300">
        <p>主片：到第 {breakIndex + 1} 句，约 <span className="tabular-nums text-ink-50">{fmt(mainMs)}</span></p>
        <p className="mt-1">续集：引子 {introEnd + 1} 句 + 提醒语 + 剩下的，约 <span className="tabular-nums text-ink-50">{fmt(sequelMs)}</span></p>
        <p className="mt-1.5 text-ink-500">提醒语：{plan.reminderPreview}</p>
      </div>

      {error && <p className="text-[11px] text-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button" disabled={busy} onClick={() => void confirm()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-sm font-extrabold text-ink-950 disabled:opacity-50"
        >
          {busy ? <IconLoader className="size-4 animate-spin" /> : <IconScissors className="size-4" />}
          {busy ? '拆分中…' : '就按这里拆'}
        </button>
        <button
          type="button" disabled={busy} onClick={onCancel}
          className="rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-ink-300 disabled:opacity-50"
        >
          先不拆
        </button>
      </div>
    </div>
  )
}

/** 一键把项目名应用到封面标题和片内标题（续集自动加 2） */
export function ApplyNameButton ({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await api.post(`/api/projects/${projectId}/titles/apply-name`)
          setOk(true)
          setTimeout(() => setOk(false), 1800)
          onDone()
        } finally { setBusy(false) }
      }}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[11px] font-medium text-ink-200 transition-colors hover:border-ink-600 disabled:opacity-50"
    >
      {ok ? <IconCheck className="size-3.5 text-accent" /> : null}
      {ok ? '已应用' : '用项目名做标题'}
    </button>
  )
}
