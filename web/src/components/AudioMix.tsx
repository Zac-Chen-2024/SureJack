import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useProjects } from '../store/projects'

/**
 * 音频面板：两条轨的波形 + 响度，各自可调。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 用户报「声音小且不可调」。查出来是两件事：配音的音量根本没有滑块
 * （只有背景音乐能调），而且 ffmpeg 的 amix 默认把每一路除以路数，
 * 选了音乐的片子凭空低 6 分贝——这些在界面上一点痕迹都没有。
 *
 * 所以这一屏不只是加个滑块，而是【把声音这件事摊开给人看】：
 * 每条轨多响、离平台基准差多少、建议压到哪儿。
 *
 * ── 数据是预先算好的 ────────────────────────────────────────────────
 * 波形和响度在配音完成 / 选中音乐时就在服务端量好落库了（见 audio/routes.ts）。
 * 这里只负责画。10 分钟的音频让手机现解码算包络会卡住好几秒，
 * 而这一屏正是要来回拖滑块的地方。
 */

interface Track {
  lufs: number
  truePeak: number
  peaks: number[]
  durationMs: number
}

interface AudioInfo {
  voice: Track | null
  bgm: Track | null
  voiceGain: number
  bgmVolume: number
  target: { lufs: number, truePeak: number }
  recommended: { voiceGain: number, bgmVolume: number, musicBelowVoiceDb: number }
}

/** 增益换算成分贝，给人看的 */
function toDb (gain: number): string {
  if (gain <= 0) return '静音'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

/** 一条轨调过增益之后的响度。LUFS 是对数刻度，加增益就是加分贝 */
function afterGain (lufs: number, gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY
  return lufs + 20 * Math.log10(gain)
}

function fmtLufs (v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)}` : '—'
}

/**
 * 波形。用 canvas 而不是几百个 div：600 根柱子用 DOM 画，
 * 手机上滚动会明显掉帧。
 */
function Wave ({ peaks, gain, tint }: { peaks: number[], gain: number, tint: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const cv = ref.current
    if (cv === null) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const w = cv.clientWidth
    const h = cv.clientHeight
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const g = cv.getContext('2d')
    if (g === null) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    if (peaks.length === 0) return

    /*
     * 【增益直接反映在波形高度上】。拖滑块时波形跟着长高/变矮——
     * 用户看到的就是他改的那件事，不用去读数字。
     */
    const mid = h / 2
    const step = w / peaks.length
    g.fillStyle = tint
    for (let i = 0; i < peaks.length; i++) {
      const v = Math.min(1, (peaks[i] ?? 0) * gain)
      const half = Math.max(0.5, v * (h / 2 - 1))
      g.fillRect(i * step, mid - half, Math.max(0.5, step * 0.8), half * 2)
    }
  }, [peaks, gain, tint])

  return <canvas ref={ref} className="h-12 w-full" />
}

/** 一条轨：标题 + 波形 + 读数 + 滑块 */
function TrackRow ({
  label, track, gain, onGain, tint, max, hint, recommend, onUseRecommend,
}: {
  label: string
  track: Track | null
  gain: number
  onGain: (v: number) => void
  tint: string
  max: number
  hint: string
  recommend: number
  onUseRecommend: () => void
}) {
  const after = track === null ? Number.NEGATIVE_INFINITY : afterGain(track.lufs, gain)
  const near = Math.abs(gain - recommend) < 0.02

  return (
    <div className="rounded-xl border border-line bg-ink-850 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-bold text-ink-100">{label}</span>
        <span className="tabular-nums text-[11px] text-ink-400">
          {track === null ? '还没有' : `${fmtLufs(after)} LUFS · ${toDb(gain)}`}
        </span>
      </div>

      <div className="mt-2 rounded-lg bg-ink-900 px-1 py-1">
        {track === null
          ? <div className="flex h-12 items-center justify-center text-[11px] text-ink-500">{hint}</div>
          : <Wave peaks={track.peaks} gain={gain} tint={tint} />}
      </div>

      <input
        type="range" min={0} max={Math.round(max * 100)} step={1}
        value={Math.round(gain * 100)}
        disabled={track === null}
        onChange={(e) => onGain(Number(e.target.value) / 100)}
        aria-label={`${label}音量`}
        className="mt-2.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 disabled:opacity-40"
        style={{ accentColor: 'var(--color-accent)' }}
      />

      {track !== null && (
        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <span className="text-ink-500">原始 {fmtLufs(track.lufs)} LUFS</span>
          {near
            ? <span className="text-accent">已是建议值</span>
            : (
              <button
                type="button" onClick={onUseRecommend}
                className="rounded-md border border-line px-2 py-0.5 text-ink-300 transition-colors hover:border-accent hover:text-accent"
              >
                用建议值 {toDb(recommend)}
              </button>
            )}
        </div>
      )}
    </div>
  )
}

export function AudioMix () {
  const project = useProjects((s) => s.current())
  const patch = useProjects((s) => s.patchProject)
  const [info, setInfo] = useState<AudioInfo | null>(null)
  const [voiceGain, setVoiceGain] = useState(1)
  const [bgmVolume, setBgmVolume] = useState(0.15)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const id = project?.id ?? null
  useEffect(() => {
    if (id === null) return
    let dead = false
    void api.get<AudioInfo>(`/api/projects/${id}/audio`).then((r) => {
      if (dead) return
      setInfo(r)
      setVoiceGain(r.voiceGain)
      setBgmVolume(r.bgmVolume)
    }).catch(() => { /* 拿不到就先不画，别弹错 */ })
    return () => { dead = true }
  }, [id, project?.bgmLibraryId, project?.ttsState])

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  /* 【本地立刻跟手、落库节流】。每一帧发一次 PATCH 会打出上百个请求 */
  function push (next: { voiceGain?: number, bgmVolume?: number }): void {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void patch(next) }, 300)
  }

  if (project === null) return null

  const t = info?.target.lufs ?? -14
  const mixLufs = (() => {
    const v = info?.voice === null || info?.voice === undefined
      ? null : afterGain(info.voice.lufs, voiceGain)
    if (v === null) return null
    // 音乐压得比人声低很多时，对整体响度的贡献可以忽略；这里给的是量级参考
    return v
  })()

  return (
    <div className="space-y-3">
      {/*
        * 【把标准摊开写】。用户要的就是这个：平台基准是多少、现在是多少、
        * 建议怎么配。以前这些全在代码里，界面上只有一个没头没尾的百分比。
        */}
      <div className="rounded-xl border border-line bg-ink-850 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-bold text-ink-100">响度</span>
          <span className="tabular-nums text-[11px] text-accent">
            成片会归一化到 {t} LUFS
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">流媒体基准</dt>
            <dd className="tabular-nums text-sm font-bold text-ink-100">{t}</dd>
          </div>
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">当前配音</dt>
            <dd className="tabular-nums text-sm font-bold text-ink-100">
              {mixLufs === null ? '—' : fmtLufs(mixLufs)}
            </dd>
          </div>
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">音乐低于人声</dt>
            <dd className="tabular-nums text-sm font-bold text-ink-100">
              {info?.recommended.musicBelowVoiceDb ?? 10} dB
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          抖音 / B站 / YouTube 都按 −14 LUFS 上下回放，比这响会被平台压回去、
          比这轻则听着发闷。成片最后会自动对到这个基准，下面两条是在此之上的配比。
        </p>
      </div>

      <TrackRow
        label="配音" track={info?.voice ?? null} gain={voiceGain}
        tint="rgba(61,220,228,0.85)" max={4}
        hint="还没生成配音"
        recommend={info?.recommended.voiceGain ?? 1}
        onUseRecommend={() => {
          const v = info?.recommended.voiceGain ?? 1
          setVoiceGain(v); push({ voiceGain: v })
        }}
        onGain={(v) => { setVoiceGain(v); push({ voiceGain: v }) }}
      />

      <TrackRow
        label="背景音乐" track={info?.bgm ?? null} gain={bgmVolume}
        tint="rgba(224,168,46,0.85)" max={1}
        hint="还没选背景音乐"
        recommend={info?.recommended.bgmVolume ?? 0.15}
        onUseRecommend={() => {
          const v = info?.recommended.bgmVolume ?? 0.15
          setBgmVolume(v); push({ bgmVolume: v })
        }}
        onGain={(v) => { setBgmVolume(v); push({ bgmVolume: v }) }}
      />
    </div>
  )
}
