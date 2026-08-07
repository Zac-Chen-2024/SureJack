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
  /** 当前实测的响度差（LU）。服务端算的初值，拖滑块时前端自己重算 */
  gapLu: number | null
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
  /**
   * 我的音频配置：一组调好的增益。
   * ⚠️【存下来不会自动套到任何项目】——要用得点「应用」。自动套的话，
   * 用户改一条片子的音量会莫名其妙影响到别的，那是最难查的一类怪事。
   */
  const [preset, setPreset] = useState<{ voiceGain: number, bgmVolume: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void api.get<{ preset: { voiceGain: number, bgmVolume: number } | null }>('/api/audio-preset')
      .then((r) => setPreset(r.preset))
      .catch(() => { /* 没有就没有 */ })
  }, [])

  /** 一句话提示，两秒后自己消失。不弹窗——这是个轻动作 */
  function flash (msg: string): void {
    setNote(msg)
    setTimeout(() => setNote(null), 2000)
  }

  function savePreset (): void {
    const p = { voiceGain, bgmVolume }
    void api.put<{ preset: typeof p }>('/api/audio-preset', p)
      .then(() => { setPreset(p); flash('已存为你的配置') })
      .catch(() => flash('没存上，再试一次'))
  }

  function applyPreset (): void {
    if (preset === null) return
    setVoiceGain(preset.voiceGain)
    setBgmVolume(preset.bgmVolume)
    void patch({ voiceGain: preset.voiceGain, bgmVolume: preset.bgmVolume })
    flash('已套用你的配置')
  }

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
  /*
   * 【响度差实时重算】。服务端给的 gapLu 是【打开这一屏那一刻】的值；
   * 用户一拖滑块它就过期了。所以这里跟着本地的两个增益自己算，
   * 不然又会变成"面板上那个数永远不动"。
   */
  const gap = (info?.voice == null || info?.bgm == null)
    ? null
    : (info.voice.lufs + 20 * Math.log10(Math.max(1e-6, voiceGain)))
      - (info.bgm.lufs + 20 * Math.log10(Math.max(1e-6, bgmVolume)))
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
          <span className="text-[11px] text-ink-400">你调多少，成片就是多少</span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">平台参考</dt>
            <dd className="tabular-nums text-sm font-bold text-ink-400">{t}</dd>
          </div>
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">成片配音</dt>
            <dd className={`tabular-nums text-sm font-bold ${
              mixLufs !== null && Math.abs(mixLufs - t) <= 2 ? 'text-accent' : 'text-ink-100'}`}
            >
              {mixLufs === null ? '—' : fmtLufs(mixLufs)}
            </dd>
          </div>
          {/*
            * ⚠️【这个数必须是【实测差】，不能显示那个建议常量】。
            * 踩过：面板上永远写着 10 dB，不管用户把滑块拖到哪儿——
            * 它显示的是 MUSIC_BELOW_VOICE_DB 这个常量，而不是当前两条轨
            * 调完增益之后的实际响度差。
            *
            * 这个量的专业名字是【响度差】，基准 ITU-R BS.1770 / EBU R128，
            * 单位 LU：两条轨各自的 LUFS 相减。广播里旁白配乐床的惯例是
            * 低 10–15 LU。
            */}
          <div className="rounded-lg bg-ink-900 py-2">
            <dt className="text-[10px] text-ink-500">音乐低于人声</dt>
            <dd className={`tabular-nums text-sm font-bold ${
              gap !== null && gap >= 8 && gap <= 16 ? 'text-accent' : 'text-ink-100'}`}
            >
              {gap === null ? '—' : `${gap.toFixed(1)} LU`}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          {/* ⚠️ JSX 里是纯文本，写 **加粗** 会把星号原样显示出来。要强调就用元素 */}
          平台按 −14 LUFS 上下回放，这里只作参考、
          <span className="text-ink-200">不会自动帮你压到那儿</span>
          ；滑块给多少，成片就是多少。乐床通常压在人声之下 10–15 LU
          （ITU-R BS.1770 响度差），太响会盖住人声、太轻等于没有。
        </p>

        {/* 保存 / 应用配置：调好一次，之后别的项目直接套 */}
        <div className="mt-2.5 flex gap-2">
          <button
            type="button" onClick={savePreset}
            className="flex-1 rounded-lg border border-line py-2 text-[11px] font-bold text-ink-200 transition-colors hover:border-accent hover:text-accent"
          >
            保存为我的配置
          </button>
          <button
            type="button" onClick={applyPreset} disabled={preset === null}
            className="flex-1 rounded-lg border border-line py-2 text-[11px] font-bold text-ink-200 transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {preset === null ? '还没存过配置' : '应用我的配置'}
          </button>
        </div>
        {note !== null && <p className="mt-1.5 text-center text-[11px] text-accent">{note}</p>}
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
