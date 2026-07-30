import { IconChevronLeft, IconChevronRight, IconTextLines, IconUpload } from '../ui/Icon'

/**
 * 起始选择（概念图 Screen 3）：**文本 / 自备，二选一**。
 *
 * 新项目建好时里头空空如也，直接丢进全屏预览会是一块黑。这一屏先问
 * "怎么开始"，把产品的两条路一次讲清：文本走 AI 配音、自备直接传 mp3+srt。
 * 每张卡片用一串流程标签告诉用户各自会经过哪几步、省掉哪几步——选之前
 * 就知道自己在选什么。
 *
 * 它不写库、不改后端：只是根据选择打开对应的底部抽屉（文案 / 配音上传），
 * 之后两条路仍随时能改。
 */

const FLOW_TEXT = ['文案', 'AI 配音', '卡拉OK字幕', '拼背景', '合成']
const FLOW_BYO = ['上传 mp3+srt', '拼背景', '合成']

function Flow ({ steps }: { steps: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {steps.map((s, i) => (
        <span
          key={s}
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${
            i === 0 ? 'border-accent/30 text-accent' : 'border-line text-ink-300'
          }`}
          style={{ background: 'var(--color-ink-950)' }}
        >
          {s}
        </span>
      ))}
    </div>
  )
}

export function MobileStartSelect ({ onBack, onPick }: {
  onBack: () => void
  onPick: (mode: 'text' | 'byo') => void
}) {
  return (
    <div
      className="absolute inset-0 overflow-y-auto bg-ink-950 px-6 pb-8"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
    >
      {/* ── 顶部导航 ───────────────────────────────────────────────── */}
      <div className="mb-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="flex size-9 items-center justify-center rounded-full border border-line bg-ink-900 text-ink-100"
        >
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
        </button>
        <span className="text-[13px] font-semibold text-ink-400">步骤 1 / 4</span>
      </div>

      <h2 className="text-2xl font-extrabold tracking-tight text-ink-50">怎么开始？</h2>
      <p className="mb-6 mt-2 text-sm leading-relaxed text-ink-400">
        选择这个项目的起始方式，之后都能改。
      </p>

      {/* ── 文本起始（推荐）─────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => onPick('text')}
        className="relative block w-full overflow-hidden rounded-2xl border border-line p-5 text-left transition-colors hover:border-accent/50"
        style={{ background: 'linear-gradient(160deg,var(--color-ink-850),var(--color-ink-900))' }}
      >
        <span className="mb-4 flex size-13 items-center justify-center rounded-2xl border border-accent/35 bg-accent/12 text-accent">
          <IconTextLines className="size-6" />
        </span>
        <span className="flex items-center gap-2.5">
          <span className="text-lg font-extrabold text-ink-50">文本起始</span>
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10.5px] font-extrabold text-ink-950">推荐</span>
        </span>
        <p className="mt-2 pr-6 text-[13px] leading-relaxed text-ink-400">
          写或粘贴文案，SureJack 用 AI 配音（可选音色、语速）并自动生成逐字字幕。
        </p>
        <Flow steps={FLOW_TEXT} />
        <span className="absolute bottom-5 right-4 text-ink-600"><IconChevronRight className="size-5" /></span>
      </button>

      {/* 分隔：或 */}
      <div className="my-4 flex items-center gap-3.5 text-xs text-ink-600">
        <span className="h-px flex-1 bg-line" />或<span className="h-px flex-1 bg-line" />
      </div>

      {/* ── 自备起始 ───────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => onPick('byo')}
        className="relative block w-full overflow-hidden rounded-2xl border border-line p-5 text-left transition-colors hover:border-[#e0a82e]/50"
        style={{ background: 'linear-gradient(160deg,var(--color-ink-850),var(--color-ink-900))' }}
      >
        <span className="mb-4 flex size-13 items-center justify-center rounded-2xl border border-[#e0a82e]/35 bg-[#e0a82e]/12 text-[#e0a82e]">
          <IconUpload className="size-6" />
        </span>
        <span className="text-lg font-extrabold text-ink-50">自备起始</span>
        <p className="mt-2 pr-6 text-[13px] leading-relaxed text-ink-400">
          已有配音就上传自己的音频（mp3）+ 字幕（srt），跳过 AI 配音，直接进入背景与合成。
        </p>
        <Flow steps={FLOW_BYO} />
        <span className="absolute bottom-5 right-4 text-ink-600"><IconChevronRight className="size-5" /></span>
      </button>
    </div>
  )
}
