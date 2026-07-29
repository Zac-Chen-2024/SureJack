import { useEffect, useState } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { useFilmStatus } from '../hooks/useFilmStatus'
import { FilmPlayer } from '../components/FilmPlayer'
import { ScriptEditor } from '../components/ScriptEditor'
import { VoicePanel } from '../components/VoicePanel'
import { SubtitleHeight } from '../components/SubtitleHeight'
import { SubtitleList } from '../components/SubtitleList'
import { AssetPanel } from '../components/AssetPanel'
import { ProjectSwitcher } from '../components/ProjectSwitcher'
import { AccountMenu } from '../components/AccountMenu'
import { PaletteToggle } from '../components/PaletteToggle'
import { BottomSheet } from '../components/mobile/BottomSheet'
import { AmbientBackdrop } from '../components/AmbientBackdrop'
import { BUILD_SHA, buildTimeLocal } from '../build-info'
import {
  IconMic, IconSubtitles, IconMusic, IconEdit, IconPreview,
} from '../components/ui/Icon'

/**
 * 手机版工作台：**全屏成片 + 底部抽屉**。
 *
 * 竖屏 9:16 的成片和手机屏天然同构，所以让画面当绝对主角、占满中间；
 * 编辑能力(文案/配音/字幕/背景音乐)收进底部一排入口，点哪个从底部滑出
 * 对应面板、用完即走，主屏始终保持干净。所有面板都直接复用桌面版的组件，
 * 不重写——手机版只是换了个盛放它们的壳。
 *
 * 数据装配和桌面版 Workspace 一模一样(切项目重取素材/字幕、盯合成状态、
 * 轮询列表进度)，这里照抄那几个 effect。
 */

type Sheet = 'script' | 'voice' | 'subtitle' | 'bgm' | null

const DOCK: { key: Exclude<Sheet, null>; label: string; icon: typeof IconMic }[] = [
  { key: 'script', label: '文案', icon: IconEdit },
  { key: 'voice', label: '配音', icon: IconMic },
  { key: 'subtitle', label: '字幕', icon: IconSubtitles },
  { key: 'bgm', label: '背景乐', icon: IconMusic },
]

const SHEET_TITLE: Record<Exclude<Sheet, null>, string> = {
  script: '文案', voice: '配音', subtitle: '字幕', bgm: '背景音乐',
}

export function MobileWorkspace () {
  const { load, current } = useProjects()
  useEffect(() => { load() }, [load])
  const project = current()

  const loadAssets = usePipeline((s) => s.loadAssets)
  const resetPipeline = usePipeline((s) => s.reset)
  const resetPlan = useLibrary((s) => s.resetPlan)
  useEffect(() => {
    if (project?.id) { resetPipeline(); resetPlan(); void loadAssets(project.id) }
  }, [project?.id, loadAssets, resetPipeline, resetPlan])

  const loadSubtitles = useSubtitles((s) => s.load)
  const resetSubtitles = useSubtitles((s) => s.reset)
  const setCurrentMs = useSubtitles((s) => s.setCurrentMs)
  const currentMs = useSubtitles((s) => s.currentMs)
  const seekNonce = useSubtitles((s) => s.seekNonce)
  useEffect(() => {
    if (!project?.id) { resetSubtitles(); return }
    void loadSubtitles(project.id)
  }, [project?.id, project?.ttsState, loadSubtitles, resetSubtitles])

  useFilmStatus(project ?? null)

  // 列表进度(切项目切换器里显示)——和桌面版同一套
  const pollFilmProgress = usePipeline((s) => s.pollFilmProgress)
  const projectIds = useProjects((s) => s.items.map((p) => p.id).join(','))
  useEffect(() => {
    if (!projectIds) return
    const ids = projectIds.split(',')
    void pollFilmProgress(ids)
    const t = setInterval(() => { void pollFilmProgress(ids) }, 5000)
    return () => clearInterval(t)
  }, [projectIds, pollFilmProgress])

  const masterReady = usePipeline((s) => s.film?.masterReady === true)
  const [sheet, setSheet] = useState<Sheet>(null)
  // 换项目时收起抽屉，别让"上一个项目的配音面板"停在新项目上
  useEffect(() => { setSheet(null) }, [project?.id])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-ink-950">
      <AmbientBackdrop />

      {/* ── 顶栏：项目切换 + 主题/账户 ────────────────────────────── */}
      <div
        className="relative z-10 flex shrink-0 items-center gap-1 border-b border-line bg-ink-900/80 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="min-w-0 flex-1"><ProjectSwitcher /></div>
        <PaletteToggle />
        <div className="pr-1"><AccountMenu /></div>
      </div>

      {/* ── 画面：成片就绪播成片，否则一句引导 ────────────────────── */}
      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-3 py-3">
        {!project ? (
          <p className="text-sm text-ink-400">先在上面选一个项目。</p>
        ) : masterReady ? (
          <div className="mx-auto flex h-full w-full max-w-[min(100%,52vh)] items-center">
            <div className="w-full">
              <FilmPlayer
                onTimeChange={setCurrentMs}
                seek={seekNonce > 0 ? { ms: currentMs, nonce: seekNonce } : null}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            <IconPreview className="size-8 text-ink-600" />
            <p className="text-sm text-ink-200">还没有成片</p>
            <p className="text-xs leading-relaxed text-ink-400">
              写好文案后点「配音」生成，或在「配音」里拖入你自己的音频和字幕。
              合成好了这里就会自动出现成片。
            </p>
            <button
              type="button"
              onClick={() => setSheet('script')}
              className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-accent-dim"
            >
              开始写文案
            </button>
          </div>
        )}
      </div>

      {/* ── 底部 dock：4 个编辑入口 ───────────────────────────────── */}
      <nav
        className="relative z-10 flex shrink-0 border-t border-line bg-ink-900/90 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {DOCK.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSheet(key)}
            disabled={!project}
            className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] text-ink-400 transition-colors hover:text-ink-100 active:text-accent disabled:opacity-40"
          >
            <Icon className="size-5" />
            {label}
          </button>
        ))}
      </nav>

      {/* ── 抽屉：装桌面版的组件，一个也不重写 ────────────────────── */}
      <BottomSheet open={sheet === 'script'} onClose={() => setSheet(null)} title={SHEET_TITLE.script}>
        {/* 文案编辑器本来靠父容器给高度，这里给它一段固定高度好写字 */}
        <div className="h-[46vh]"><ScriptEditor /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'voice'} onClose={() => setSheet(null)} title={SHEET_TITLE.voice}>
        <VoicePanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'subtitle'} onClose={() => setSheet(null)} title={SHEET_TITLE.subtitle}>
        <SubtitleHeight />
        <div className="mt-4 h-[40vh] border-t border-line pt-2">
          <SubtitleList />
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === 'bgm'} onClose={() => setSheet(null)} title={SHEET_TITLE.bgm}>
        <AssetPanel />
      </BottomSheet>

      {/* 版本角标：排查用，压到最不起眼处 */}
      <div className="pointer-events-none fixed bottom-1 right-2 z-40 text-[9px] tabular-nums text-ink-700">
        {BUILD_SHA} · {buildTimeLocal()}
      </div>
    </div>
  )
}
