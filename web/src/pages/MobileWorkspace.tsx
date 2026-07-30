import { useEffect, useState } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { useFilmStatus } from '../hooks/useFilmStatus'
import { useNav, topScreen, topSheet, type Sheet } from '../store/nav'
import { useNavHistory } from '../hooks/useNavHistory'
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
import { AppUpdateBanner } from '../components/mobile/AppUpdateBanner'
import { BUILD_SHA, buildTimeLocal } from '../build-info'
import {
  IconTextLines, IconMic, IconTypeTool, IconFrame, IconMusic,
  IconChevronLeft, IconChevronDown, IconPreview,
} from '../components/ui/Icon'

/**
 * 手机版工作台 —— 概念图「方案 A」四屏，导航挂在浏览器 History 上（见
 * store/nav.ts）：系统返回键 / 屏幕左缘左滑天然退栈，配 CSS 转场。
 *
 *   list   项目列表（根）
 *   editor 全屏预览（空项目时叠"起始选择"；成片就绪播成片，否则引导空态）
 *   sheet  底部抽屉（文案/配音/字幕/背景/音乐），叠在 editor 上
 *
 * 抽屉里全是桌面那几个组件（ScriptEditor / VoicePanel / …），一个不重写；
 * 手机版只提供 BottomSheet 的壳和这套导航。
 */

/** 底栏五格。图标照概念图：文案=三行字、配音=麦、字幕=T、背景=画框、音乐=音符 */
const DOCK: { key: Sheet; label: string; icon: typeof IconMic }[] = [
  { key: 'script', label: '文案', icon: IconTextLines },
  { key: 'voice', label: '配音', icon: IconMic },
  { key: 'subtitle', label: '字幕', icon: IconTypeTool },
  { key: 'background', label: '背景', icon: IconFrame },
  { key: 'music', label: '音乐', icon: IconMusic },
]
const SHEET_TITLE: Record<Sheet, string> = {
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

  // ── 导航（History 栈）────────────────────────────────────────────────
  useNavHistory()
  const stack = useNav((s) => s.stack)
  const dir = useNav((s) => s.dir)
  const push = useNav((s) => s.push)
  const back = useNav((s) => s.back)
  const screen = topScreen(stack)
  const sheet = topSheet(stack)

  const masterReady = usePipeline((s) => s.film?.masterReady === true)
  // 哪些项目这次会话过了"起始选择"。空项目第一次进要先选文本/自备
  const [startedIds, setStartedIds] = useState<Set<string>>(new Set())

  function openProject (id: string) {
    useProjects.getState().select(id)
    push({ k: 'editor' })
  }

  const needsStart = !!project &&
    !startedIds.has(project.id) &&
    project.ttsState === 'none' &&
    (project.scriptText ?? '').trim().length === 0

  return (
    <div className="relative h-full overflow-hidden bg-black">
      {/* 屏级容器：换屏时按方向滑入（进=从右、退=从左带视差）。抽屉开合不换屏，
          所以只有 list↔editor 切换才会重放这个动画。 */}
      <div
        key={screen}
        className={`absolute inset-0 ${dir === 'fwd' ? 'sj-screen-fwd' : 'sj-screen-back'}`}
      >
        {screen === 'list' ? (
          <MobileProjectList onOpen={openProject} />
        ) : !project ? (
          <MobileProjectList onOpen={openProject} />
        ) : needsStart ? (
          <MobileStartSelect
            onBack={back}
            onPick={(mode) => {
              setStartedIds((s) => new Set(s).add(project.id))
              push({ k: 'sheet', name: mode === 'text' ? 'script' : 'voice' })
            }}
          />
        ) : (
          <>
            {masterReady
              ? <MobileFilmPlayer onBack={back} />
              : <EmptyPreview onBack={back} projectName={project.name} onWriteScript={() => push({ k: 'sheet', name: 'script' })} />}

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
                    onClick={() => push({ k: 'sheet', name: key })}
                    className="flex w-[60px] flex-col items-center gap-1.5"
                  >
                    <span
                      className={`flex size-[46px] items-center justify-center rounded-2xl border transition-colors ${
                        active ? 'border-accent/40 bg-accent/12 text-accent' : 'border-white/10 bg-white/[0.06] text-white'
                      }`}
                    >
                      <Icon className="size-[22px]" strokeWidth={1.8} />
                    </span>
                    <span className={`text-[11.5px] font-semibold ${active ? 'text-accent' : 'text-white/70'}`}>{label}</span>
                  </button>
                )
              })}
            </nav>
          </>
        )}
      </div>

      {/* ── 抽屉：装桌面版组件，一个不重写。关闭走 back()（=系统返回键同一条路）── */}
      <BottomSheet open={sheet === 'script'} onClose={back} title={SHEET_TITLE.script}>
        <div className="h-[42vh]"><ScriptEditor /></div>
        <div className="mt-4 border-t border-line pt-3"><NameReplacePanel /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'voice'} onClose={back} title={SHEET_TITLE.voice}>
        <VoicePanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'subtitle'} onClose={back} title={SHEET_TITLE.subtitle}>
        <SubtitleHeight />
        <div className="mt-4 h-[42vh] border-t border-line pt-2"><SubtitleList /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'background'} onClose={back} title={SHEET_TITLE.background}>
        <BackgroundPanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'music'} onClose={back} title={SHEET_TITLE.music}>
        <MusicPanel />
      </BottomSheet>

      <AppUpdateBanner />
      <VersionBadge />
    </div>
  )
}

/** 成片还没好时的引导空态。顶栏药丸（返回列表）+ 引导。 */
function EmptyPreview ({ onBack, projectName, onWriteScript }: {
  onBack: () => void; projectName: string; onWriteScript: () => void
}) {
  return (
    <div className="absolute inset-0 bg-ink-950">
      <div className="absolute inset-x-0 z-20 flex px-4" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}>
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
          写好文案后点「配音」生成，或在「配音」里选入你自己的音频和字幕。合成好了这里就会自动出现成片。
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
