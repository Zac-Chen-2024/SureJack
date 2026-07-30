import { useEffect } from 'react'
import { useProjects } from '../store/projects'
import { useRename, readReview, type CharacterRole, type RenameAnalysis } from '../store/rename'
import { IconLoader, IconCheck, IconEdit } from './ui/Icon'

/**
 * 人名谐音替换面板。**只对文本项目出现**（自备音频路声音已固化，改名无意义）。
 *
 * 位置：移动端在「文案」抽屉、编辑器下方；桌面在「文本」栏文案编辑器下方。
 *
 * 流程：开关 → 分析人名(调 DeepSeek 出提案) → 审核/编辑替换表 + 看关系图 →
 * 确认替换（把改名后的文案写回，之后才允许配音）。LLM 只出映射，替换由
 * 后端确定性执行。
 */

const ROLE: Record<CharacterRole, { label: string; cls: string }> = {
  protagonist: { label: '主角', cls: 'text-accent border-accent/40 bg-accent/10' },
  related: { label: '相关', cls: 'text-[#e0a82e] border-[#e0a82e]/40 bg-[#e0a82e]/10' },
  minor: { label: '配角', cls: 'text-ink-300 border-line bg-ink-800' },
}

export function NameReplacePanel () {
  const project = useProjects((s) => s.current())
  const { draft, busy, error, step, hydrate, analyze, editReplacement, confirm, toggle, retryReview } = useRename()
  // 第二层复查的结果/错误存在 renameAnalysisJson 里，读出来给状态行用
  const { review, error: reviewError } = readReview(project?.renameAnalysisJson ?? null)

  // 切项目 / 映射更新时，从项目已存映射恢复草稿
  useEffect(() => { hydrate(project ?? null) }, [project?.id, project?.renameMapJson, hydrate])

  // 只对文本项目显示（自备路不显示）
  if (!project || project.subtitleMode === 'line') return null

  const enabled = project.renameEnabled
  const state = project.renameState

  return (
    <div className="rounded-xl border border-line bg-ink-900/60 p-3">
      {/* ── 头：标题 + 开关 ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
          <IconEdit className="size-3.5" />人名替换
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy}
          onClick={() => void toggle(project.id, !enabled)}
          className={`ml-auto flex h-5 w-9 items-center rounded-full px-0.5 transition-colors disabled:opacity-50 ${enabled ? 'bg-accent' : 'bg-ink-700'}`}
        >
          <span className={`size-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`} />
        </button>
      </div>

      {!enabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          开启后，把小说里的人名换成谐音（保留姓、只换名，主角用好字），并去掉章节标题。
          改完的文案才拿去配音。
        </p>
      ) : (
        <>
          <StatusLine state={state} />

          <button
            type="button"
            onClick={() => void analyze(project.id)}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-200 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {busy
              ? <><IconLoader className="size-3.5 animate-spin" />分析中…</>
              : state === 'none' ? '分析人名' : '重新分析'}
          </button>

          {/* 出错就把重试按钮摆在错误旁边——哪一步崩了就重试哪一步，
              不用把整条流程从头走一遍 */}
          {error && (
            <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 p-2">
              <p className="text-[11px] leading-relaxed text-danger">{error}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (step === 'review') void retryReview(project.id)
                  else if (step === 'confirm') void confirm(project.id)
                  else void analyze(project.id)
                }}
                className="mt-1.5 rounded-md border border-danger/50 px-2 py-1 text-[11px] font-medium text-danger disabled:opacity-50"
              >
                重试
              </button>
            </div>
          )}

          {/* 第二层复查（API-2）的结果与重试。它负责捞第一层漏掉的非正文——
              尤其孤立的章节号数字行那种只有语义判得出的 */}
          {state === 'confirmed' && (
            <div className="mt-2 rounded-lg bg-ink-850 p-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-400">清理复查</span>
                {reviewError
                  ? <span className="text-[11px] text-danger">失败</span>
                  : review
                    ? <span className="text-[11px] text-accent">
                        已复查{review.removeLines.length > 0 ? ` · 又清掉 ${review.removeLines.length} 处` : ' · 没有漏网'}
                      </span>
                    : <span className="text-[11px] text-ink-400">未复查</span>}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void retryReview(project.id)}
                  className="ml-auto rounded-md border border-line px-2 py-1 text-[11px] text-ink-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {busy && step === 'review' ? '复查中…' : '再查一遍'}
                </button>
              </div>
              {reviewError && <p className="mt-1 text-[11px] leading-relaxed text-danger">{reviewError}</p>}
              {review && review.leftoverNames.length > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-[#e0a82e]">
                  疑似还有没改的名字：{review.leftoverNames.join('、')}
                </p>
              )}
            </div>
          )}

          {draft && draft.characters.length > 0 && (
            <>
              <RelationshipGraph analysis={draft} />

              <div className="mt-3 space-y-1.5">
                {draft.characters.map((c, i) => (
                  <div key={c.original + i} className="flex items-center gap-2 rounded-lg bg-ink-850 px-2.5 py-1.5">
                    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${ROLE[c.role].cls}`}>
                      {ROLE[c.role].label}
                    </span>
                    <span className="shrink-0 text-xs text-ink-400 line-through">{c.original}</span>
                    <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-ink-600" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    <input
                      value={c.replacement}
                      onChange={(e) => editReplacement(i, e.target.value)}
                      aria-label={`${c.original} 的新名`}
                      className="min-w-0 flex-1 rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-ink-50 outline-none focus:border-accent"
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => void confirm(project.id)}
                disabled={busy}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-50"
              >
                <IconCheck className="size-3.5" />
                {state === 'confirmed' ? '重新确认替换' : '确认替换（之后即可配音）'}
              </button>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
                确认后会把改名+去章节的文案写回文案框，并解锁配音。可随时重新分析或改名再确认。
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}

function StatusLine ({ state }: { state: string }) {
  const map: Record<string, { text: string; cls: string }> = {
    none: { text: '还没分析人名', cls: 'text-ink-400' },
    analyzing: { text: '分析中…', cls: 'text-ink-400' },
    proposed: { text: '已出草案，待你确认', cls: 'text-[#e0a82e]' },
    confirmed: { text: '已确认，配音将用改名后的文案', cls: 'text-accent' },
  }
  const s = map[state] ?? map.none!
  return <p className={`mt-2 text-[11px] font-medium ${s.cls}`}>{s.text}</p>
}

/**
 * 关系图。角色排在一个圆上，关系连线 + 关系词标在中点。
 * 简单 SVG、无依赖——够看清谁跟谁什么关系即可，不追求力导向那种排布。
 */
function RelationshipGraph ({ analysis }: { analysis: RenameAnalysis }) {
  const chars = analysis.characters
  if (chars.length < 2 || analysis.relationships.length === 0) return null
  const W = 300, H = 200, cx = W / 2, cy = H / 2, r = 74
  const pos = new Map<string, { x: number; y: number }>()
  chars.forEach((c, i) => {
    const a = (2 * Math.PI * i) / chars.length - Math.PI / 2
    pos.set(c.original, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  })
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line bg-ink-950/50">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 200 }}>
        {analysis.relationships.map((rel, i) => {
          const a = pos.get(rel.a); const b = pos.get(rel.b)
          if (!a || !b) return null
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line-strong)" strokeWidth={1} />
              {rel.label && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} textAnchor="middle" className="fill-ink-400" style={{ fontSize: 9 }}>{rel.label}</text>
              )}
            </g>
          )
        })}
        {chars.map((c) => {
          const p = pos.get(c.original)!
          const tint = c.role === 'protagonist' ? 'var(--color-accent)' : c.role === 'related' ? '#e0a82e' : 'var(--color-ink-600)'
          return (
            <g key={c.original}>
              <circle cx={p.x} cy={p.y} r={5} fill={tint} />
              <text x={p.x} y={p.y - 9} textAnchor="middle" className="fill-ink-100" style={{ fontSize: 10, fontWeight: 600 }}>{c.replacement}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
