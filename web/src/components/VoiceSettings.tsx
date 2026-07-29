import { useState } from 'react'
import {
  useProjects, VOICES, RATE_RANGE, VOLUME_RANGE, PITCH_RANGE,
} from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { Select } from './ui/Select'
import { IconMic } from './ui/Icon'

/**
 * 配音参数：音色 + 语速 / 音量 / 音调。
 *
 * ── 只对「文本配音」这一路显示 ──────────────────────────────────────
 * 自备音频那条路（subtitleMode==='line'）用的是用户自己录好的 mp3，
 * 音色语速全固化在文件里，这些参数对它毫无意义——所以调用方（VoicePanel）
 * 用 isByo 把整块藏掉，这里不重复判断。
 *
 * ── 拖动不重配，确认才重配（复用字幕高度那套）──────────────────────
 * 改任一参数都要【重新调 Azure 生成配音】（烧配额）+ 重烧成片（十几分钟）。
 * 所以拖动/选择只改草稿（draftVoice），显示值 = 草稿 ?? 已存值；
 * 点「确认」才 commitVoiceParams（落库）→ 再 generateVoice（重配音，
 * 就绪后自动重烧成片）。中途那条能播能下的旧片一直有效。
 */

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n}%`

export function VoiceSettings () {
  const project = useProjects((s) => s.current())
  const draft = useProjects((s) => s.draftVoice)
  const setDraftVoice = useProjects((s) => s.setDraftVoice)
  const resetDraftVoice = useProjects((s) => s.resetDraftVoice)
  const commitVoiceParams = useProjects((s) => s.commitVoiceParams)
  const reload = useProjects((s) => s.load)
  const generateVoice = usePipeline((s) => s.generateVoice)
  const voiceBusy = usePipeline((s) => s.voiceBusy)
  const [busy, setBusy] = useState(false)

  if (!project) return null

  // 显示值：有草稿看草稿，没有看已存
  const voiceName = draft?.voiceName ?? project.voiceName
  const rate = draft?.voiceRate ?? project.voiceRate
  const volume = draft?.voiceVolume ?? project.voiceVolume
  const pitch = draft?.voicePitch ?? project.voicePitch

  const dirty = draft !== null && (
    draft.voiceName !== project.voiceName
    || draft.voiceRate !== project.voiceRate
    || draft.voiceVolume !== project.voiceVolume
    || draft.voicePitch !== project.voicePitch
  )
  // 没生成过配音时，改参数不必弹"重新配音"——直接生成即可，代价一样但话术不同
  const hasVoice = project.ttsState === 'ready'

  async function onConfirm () {
    setBusy(true)
    try {
      // 顺序关键：先把参数落库，generateVoice 从项目读参数
      await commitVoiceParams()
      await generateVoice(project!.id)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const working = busy || voiceBusy

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        <IconMic className="size-3.5" />配音音色
      </div>

      <Select
        value={voiceName}
        onChange={(e) => setDraftVoice({ voiceName: e.target.value })}
        aria-label="配音音色"
      >
        {VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </Select>

      <ParamSlider
        label="语速" value={rate} range={RATE_RANGE}
        onChange={(n) => setDraftVoice({ voiceRate: n })}
      />
      <ParamSlider
        label="音量" value={volume} range={VOLUME_RANGE}
        onChange={(n) => setDraftVoice({ voiceVolume: n })}
      />
      <ParamSlider
        label="音调" value={pitch} range={PITCH_RANGE}
        onChange={(n) => setDraftVoice({ voicePitch: n })}
      />

      {dirty ? (
        <div className="mt-3">
          <p className="mb-2 text-[11px] leading-relaxed text-ink-400">
            {hasVoice
              ? '换音色或调参数要重新配音并合成，大约十几分钟；这期间现在这条片子照常能看能下。'
              : '确认后开始按这些设置生成配音。'}
          </p>
          <div className="flex gap-2">
            <button
              type="button" onClick={() => void onConfirm()} disabled={working}
              className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-50"
            >
              {working ? '提交中…' : hasVoice ? '确认，重新配音' : '确认，生成配音'}
            </button>
            <button
              type="button" onClick={() => resetDraftVoice()} disabled={working}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-300 transition-colors hover:text-ink-50 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          音色和语速决定配音的声音。改了要重新配音，所以先选好再确认。
        </p>
      )}
    </div>
  )
}

/** 一个百分比偏移滑块。0 居中，两端是范围端点，显示 +N% / -N% */
function ParamSlider ({ label, value, range, onChange }: {
  label: string
  value: number
  range: { min: number; max: number; default: number }
  onChange: (n: number) => void
}) {
  return (
    <>
      <label className="mb-1 mt-3 flex items-baseline justify-between text-[11px] text-ink-400">
        <span>{label}</span>
        <span className="tabular-nums">{fmtPct(value)}</span>
      </label>
      <input
        type="range"
        min={range.min} max={range.max} step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700"
        style={{ accentColor: 'var(--color-accent)' }}
      />
    </>
  )
}
