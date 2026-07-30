import { useEffect, useState } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { useFilmStatus } from '../hooks/useFilmStatus'
import { ScriptEditor } from '../components/ScriptEditor'
import { NameReplacePanel } from '../components/NameReplacePanel'
import { VoicePanel } from '../components/VoicePanel'
import { SubtitleHeight } from '../components/SubtitleHeight'
import { SubtitleList } from '../components/SubtitleList'
import { BackgroundPanel, MusicPanel } from '../components/AssetPanel'
import { BottomSheet } from '../components/mobile/BottomSheet'
import { MobileProjectList } from '../components/mobile/MobileProjectList'
import { MobileStartSelect } from '../components/mobile/MobileStartSelect'
import { MobileFilmPlayer } from '../components/mobile/MobileFilmPlayer'
import { BUILD_SHA, buildTimeLocal } from '../build-info'
import {
  IconTextLines, IconMic, IconTypeTool, IconFrame, IconMusic,
  IconChevronLeft, IconChevronDown, IconPreview,
} from '../components/ui/Icon'

/**
 * 手机版工作台 —— 完全照概念图「方案 A」实现的四屏：
 *
 *   Screen 0  项目列表   ── 铺满一屏，新建 + 状态徽标
 *   Screen 3  起始选择   ── 新项目二选一：文本 / 自备
 *   Screen 1  全屏预览   ── 边到边成片，控制项浮在画面上
 *   Screen 2  底部抽屉   ── 五格底栏点开：文案/配音/字幕/背景/音乐
 *
 * ── 三个"屏"其实是两层视图 + 一个抽屉 ────────────────────────────────
 * view='list' 是 Screen 0；view='editor' 时，若项目还空着走 Screen 3，
 * 否则 Screen 1（成片就绪）或一个引导空态。抽屉（Screen 2）叠在 editor 上。
 * 全部数据装配和桌面 Workspace 同一套（切项目重取素材/字幕、盯合成、
 * 轮询列表进度），只是外壳换成手机布局。
 *
 * ── 面板一个不重写 ──────────────────────────────────────────────────
 * 抽屉里装的 ScriptEditor / VoicePanel / SubtitleList / BackgroundPanel /
 * MusicPanel 全是桌面那几个组件；手机版只提供盛放它们的壳（BottomSheet）
 * 和这套四屏导航。
 */

type Sheet = 'script' | 'voice' | 'subtitle' | 'background' | 'music' | null

/** 底栏五格。图标照概念图：文案=三行字、配音=麦、字幕=T、背景=画框、音乐=音符 */
const DOCK: { key: Exclude<Sheet, null>; label: string; icon: typeof IconMic }[] = [
  { key: 'script', label: '文案', icon: IconTextLines },
  { key: 'voice', label: '配音', icon: IconMic },
  { key: 'subtitle', label: '字幕', icon: IconTypeTool },
  { key: 'background', label: '背景', icon: IconFrame },
  { key: 'music', label: '音乐', icon: IconMusic },
]

const SHEET_TITLE: Record<Exclude<Sheet, null>, string> = {
  script: '文案', voice: '配音', subtitle: '字幕', background: '背景', music: '音乐',
}

export function MobileWorkspace () {
  const { load, current } = useProjects()
  useEffect(() => { load() }, [load])
  const project = current()

  // ── 数据装配（和桌面 Workspace 同一套 effect）──────────────────────
  const loadAssets = usePipeline((s) => s.loadAssets)
  const resetPipeline = usePipeline((s) => s.reset)
  const resetPlan = useLibrary((s) => s.resetPlan)
  useEffect(() => {
    if (project?.id) { resetPipeline(); resetPlan(); void loadAssets(project.id) }
  }, [project?.id, loadAssets, resetPipeline, resetPlan])

  const loadSubtitles = useSubtitles((s) => s.load)
  const resetSubtitles = useSubtitles((s) => s.reset)
  useEffect(() => {
    if (!project?.id) { resetSubtitles(); return }
    void loadSubtitles(project.id)
  }, [project?.id, project?.ttsState, loadSubtitles, resetSubtitles])

  useFilmStatus(project ?? null)

  const pollFilmProgress = usePipeline((s) => s.pollFilmProgress)
  const projectIds = useProjects((s) => s.items.map((p) => p.id).join(','))
  useEffect(() => {
    if (!projectIds) return
    const ids = projectIds.split(',')
    void pollFilmProgress(ids)
    const t = setInterval(() => { void pollFilmProgress(ids) }, 5000)
    return () => clearInterval(t)
  }, [projectIds, pollFilmProgress])

  // ── 视图状态 ────────────────────────────────────────────────────────
  const [view, setView] = useState<'list' | 'editor'>('list')
  const [sheet, setSheet] = useState<Sheet>(null)
  /*
   * 哪些项目这次会话已经过了"起始选择"。空项目第一次进要先选文本/自备，
   * 选过之后（哪怕还没写字）就不再拦——否则打开文案抽屉没打字、退回来
   * 又被起始屏挡住。已有内容的项目从不出现这一屏。
   */
  const [startedIds, setStartedIds] = useState<Set<string>>(new Set())

  const masterReady = usePipeline((s) => s.film?.masterReady === true)

  // 换项目：收起抽屉，别让上一个项目的面板停在新项目上
  useEffect(() => { setSheet(null) }, [project?.id])

  function openProject (id: string) {
    useProjects.getState().select(id)
    setView('editor')
  }
  function backToList () { setView('list'); setSheet(null) }

  // ── Screen 0：项目列表 ───────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div className="relative h-full overflow-hidden bg-ink-950">
        <MobileProjectList onOpen={openProject} />
        <VersionBadge />
      </div>
    )
  }

  // editor 态但项目丢了（被删）——回列表
  if (!project) {
    return (
      <div className="relative h-full overflow-hidden bg-ink-950">
        <MobileProjectList onOpen={openProject} />
        <VersionBadge />
      </div>
    )
  }

  // ── Screen 3：起始选择（仅新空项目）────────────────────────────────
  const needsStart =
    !startedIds.has(project.id) &&
    project.ttsState === 'none' &&
    (project.scriptText ?? '').trim().length === 0

  if (needsStart) {
    return (
      <div className="relative h-full overflow-hidden bg-ink-950">
        <MobileStartSelect
          onBack={backToList}
          onPick={(mode) => {
            setStartedIds((s) => new Set(s).add(project.id))
            setSheet(mode === 'text' ? 'script' : 'voice')
          }}
        />
        <VersionBadge />
      </div>
    )
  }

  // ── Screen 1：全屏预览（成片就绪）/ 引导空态 ─────────────────────────
  return (
    <div className="relative h-full overflow-hidden bg-black">
      {masterReady
        ? <MobileFilmPlayer onBack={backToList} />
        : <EmptyPreview onBack={backToList} projectName={project.name} onWriteScript={() => setSheet('script')} />}

      {/* ── 五格底栏 ──────────────────────────────────────────────── */}
      <nav
        className="absolute inset-x-0 bottom-0 z-30 flex justify-around px-2.5 pt-3.5"
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
          background: 'linear-gradient(180deg,transparent,rgba(0,0,0,0.55) 26%,#000 62%)',
        }}
      >
        {DOCK.map(({ key, label, icon: Icon }) => {
          const active = sheet === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSheet(key)}
              className="flex w-[60px] flex-col items-center gap-1.5"
            >
              <span
                className={`flex size-[46px] items-center justify-center rounded-2xl border transition-colors ${
                  active
                    ? 'border-accent/40 bg-accent/12 text-accent'
                    : 'border-white/10 bg-white/[0.06] text-white'
                }`}
              >
                <Icon className="size-[22px]" strokeWidth={1.8} />
              </span>
              <span className={`text-[11.5px] font-semibold ${active ? 'text-accent' : 'text-white/70'}`}>
                {label}
              </span>
            </button>
          )
        })}
      </nav>

      {/* ── 抽屉：装桌面版组件，一个不重写 ─────────────────────────── */}
      <BottomSheet open={sheet === 'script'} onClose={() => setSheet(null)} title={SHEET_TITLE.script}>
        <div className="h-[42vh]"><ScriptEditor /></div>
        {/* 人名替换挂在文案下方（概念图定的位置）；只对文本项目显示 */}
        <div className="mt-4 border-t border-line pt-3"><NameReplacePanel /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'voice'} onClose={() => setSheet(null)} title={SHEET_TITLE.voice}>
        <VoicePanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'subtitle'} onClose={() => setSheet(null)} title={SHEET_TITLE.subtitle}>
        <SubtitleHeight />
        <div className="mt-4 h-[42vh] border-t border-line pt-2"><SubtitleList /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'background'} onClose={() => setSheet(null)} title={SHEET_TITLE.background}>
        <BackgroundPanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'music'} onClose={() => setSheet(null)} title={SHEET_TITLE.music}>
        <MusicPanel />
      </BottomSheet>

      <VersionBadge />
    </div>
  )
}

/** 成片还没好时的引导空态。也带一条返回项目列表的顶栏药丸。 */
function EmptyPreview ({ onBack, projectName, onWriteScript }: {
  onBack: () => void; projectName: string; onWriteScript: () => void
}) {
  return (
    <div className="absolute inset-0 bg-ink-950">
      <div
        className="absolute inset-x-0 z-20 flex px-4"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-3.5 py-2 text-sm font-semibold text-ink-100"
        >
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
          <span className="max-w-[46vw] truncate">{projectName}</span>
          <IconChevronDown className="size-3.5 opacity-70" strokeWidth={2} />
        </button>
      </div>

      <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center">
        <IconPreview className="size-9 text-ink-600" />
        <p className="text-sm font-medium text-ink-100">还没有成片</p>
        <p className="text-xs leading-relaxed text-ink-400">
          写好文案后点「配音」生成，或在「配音」里选入你自己的音频和字幕。
          合成好了这里就会自动出现成片。
        </p>
        <button
          type="button"
          onClick={onWriteScript}
          className="mt-1 rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-ink-950 transition-colors hover:bg-accent-dim"
        >
          开始写文案
        </button>
      </div>
    </div>
  )
}

/** 版本角标：排查用，压到最不起眼处 */
function VersionBadge () {
  return (
    <div className="pointer-events-none fixed bottom-1 right-2 z-40 text-[9px] tabular-nums text-ink-700">
      {BUILD_SHA} · {buildTimeLocal()}
    </div>
  )
}
