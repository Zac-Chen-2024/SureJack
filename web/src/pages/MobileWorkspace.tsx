import { useEffect, useState } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { useFilmStatus } from '../hooks/useFilmStatus'
import { useNav, topScreen, topSheet, type Sheet } from '../store/nav'
import { useNavHistory } from '../hooks/useNavHistory'
import { OpeningPicker } from '../components/mobile/OpeningPicker'
import { ScriptEditor } from '../components/ScriptEditor'
import { NameReplacePanel } from '../components/NameReplacePanel'
import { VoicePanel } from '../components/VoicePanel'
import { SubtitleHeight } from '../components/SubtitleHeight'
import { CoverPanel } from '../components/CoverPanel'
import { SubtitleList } from '../components/SubtitleList'
import { BackgroundPanel, MusicPanel } from '../components/AssetPanel'
import { BottomSheet } from '../components/mobile/BottomSheet'
import { MobileProjectList } from '../components/mobile/MobileProjectList'
import { MobileNewProject } from '../components/mobile/MobileNewProject'
import { MobileStartSelect } from '../components/mobile/MobileStartSelect'
import { MobileFilmPlayer } from '../components/mobile/MobileFilmPlayer'
import { MobileGenerating } from '../components/mobile/MobileGenerating'
import { AppUpdateBanner } from '../components/mobile/AppUpdateBanner'
import { ScrubReadout } from '../components/mobile/ScrubSlider'
import { SwipeBack } from '../components/mobile/SwipeBack'
import { BUILD_SHA, buildTimeLocal } from '../build-info'
import {
  IconTextLines, IconMic, IconTypeTool, IconFrame, IconMusic,
  IconChevronLeft, IconChevronDown, IconPreview, IconLoader, IconDownload,
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

  // 在列表页时定时刷新项目，让"配音中→合成中→已完成"的状态自己往前走。
  // 只在列表页刷（编辑器没挂载），不会冲掉正在编辑的文案。
  const reloadProjects = useProjects((s) => s.load)

  // ── 导航（History 栈）────────────────────────────────────────────────
  useNavHistory()
  const stack = useNav((s) => s.stack)
  const dir = useNav((s) => s.dir)
  const push = useNav((s) => s.push)
  const replace = useNav((s) => s.replace)
  const back = useNav((s) => s.back)
  const screen = topScreen(stack)
  const sheet = topSheet(stack)
  /*
   * 首屏【不放转场动画】。工作台是在欢迎页覆盖层底下先挂好的，如果第一帧就
   * 播"从右滑入"，欢迎页淡出时底下正在滑，观感很怪。之后的换屏才有转场。
   */
  const [animateScreens, setAnimateScreens] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setAnimateScreens(true), 80)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (screen !== 'list') return
    const t = setInterval(() => { void reloadProjects() }, 5000)
    return () => clearInterval(t)
  }, [screen, reloadProjects])

  const masterReady = usePipeline((s) => s.film?.masterReady === true)
  const filmState = usePipeline((s) => s.film?.state ?? null)
  /*
   * 【成片状态"还没问出来"是第四种状态，不是"没有"】。
   * select() 会把 film 清成 null，随后才去 GET /film。网络慢的地方
   * （国外用户就是这么撞上的）这个窗口能有一两秒——期间 masterReady 是
   * false、inProgress 也是 false，于是一个明明已完成的项目点进去先给人
   * 看一屏「还没有成片 / 开始写文案」，这是彻头彻尾的假话。
   * 未知就老老实实显示封面 + 转圈，等问出来再决定。
   */
  const filmUnknown = usePipeline((s) => s.film === null)
  // 流程在跑（配音中/合成中/出错）→ 盖进度蒙层，而不是"还没成片"的空态
  const inProgress = !!project && (
    project.ttsState === 'generating' || project.ttsState === 'error'
    || filmState === 'building' || filmState === 'error'
  )
  // 哪些项目这次会话过了"起始选择"。空项目第一次进要先选文本/自备
  const [startedIds, setStartedIds] = useState<Set<string>>(new Set())

  /*
   * 【草稿点进去回到"接着完成"，而不是编辑器】。
   *
   * 用户建了项目、贴了文案，还没分析就退出去了；再点进来看到的是一屏
   * 「还没有成片」——那句话是实话，但它答的不是他此刻的问题：他要的是
   * "接着弄完"。文案还在库里，分析按钮就在新建那一页上，所以就该回那一页。
   *
   * 判据是【配音还没生成】（ttsState==='none'）：一旦配了音，这条片子就
   * 进入了预览/微调的阶段，那才是编辑器的地盘。
   */
  function openProject (id: string) {
    useProjects.getState().select(id)
    const p = useProjects.getState().items.find((x) => x.id === id)
    /*
     * 【开头还没挑完的，点进去要回到那一屏】。和上面草稿那条同一个道理：
     * 这条片子的合成正被闸门拦着，给他看「合成中」或者「还没有成片」
     * 都是把他晾在原地——他要做的那件事就是挑开头。
     */
    if (p && p.openingState === 'pending') { push({ k: 'opening' }) } else if (p && p.ttsState === 'none') { setResumeDraft(true); push({ k: 'newproject' }) } else push({ k: 'editor' })
  }
  /*
   * 【新建之前必须把"接着完成"的标记清掉】。同一屏（newproject）现在有两种
   * 用途：真·新建、和回到某条草稿接着填。区分靠的是"当前选中的项目是不是
   * 一条草稿"——所以点「新建项目」时得先把选中态清空，否则刚从草稿退出来
   * 再点新建，会莫名其妙地又回到那条草稿。
   */
  const [resumeDraft, setResumeDraft] = useState(true)
  function openNew () {
    setResumeDraft(false)
    push({ k: 'newproject' })
  }
  function goEditor (id: string) {
    useProjects.getState().select(id)
    replace({ k: 'editor' })   // 用编辑器替换新建页：从编辑器返回直接回列表
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
        className={`absolute inset-0 ${!animateScreens ? '' : dir === 'fwd' ? 'sj-screen-fwd' : 'sj-screen-back'}`}
      >
        {screen === 'list' ? (
          <MobileProjectList onOpen={openProject} onNew={openNew} />
        ) : screen === 'opening' && project ? (
          /* 挑到一半退出去了：点回来接着挑。续集也在这条线上 */
          <OpeningPicker
            ids={[project, ...useProjects.getState().items.filter((x) => x.parentProjectId === project.id)]
              .filter((x) => x.openingState === 'pending')
              .map((x) => x.id)}
            onDone={() => { replace({ k: 'editor' }) }}
          />
        ) : screen === 'newproject' ? (
          /* 从列表点进一条草稿时带上 id，那一页会把名字和文案填回去接着走 */
          <MobileNewProject
            onBack={back}
            onGo={goEditor}
            resumeId={resumeDraft && project && project.ttsState === 'none' ? project.id : undefined}
          />
        ) : !project ? (
          <MobileProjectList onOpen={openProject} onNew={openNew} />
        ) : needsStart ? (
          <MobileStartSelect
            onBack={back}
            onPick={(mode) => {
              setStartedIds((s) => new Set(s).add(project.id))
              push({ k: 'sheet', name: mode === 'text' ? 'script' : 'voice' })
            }}
          />
        ) : (
          <SwipeBack onBack={back}>
            {masterReady
              ? <MobileFilmPlayer onBack={back} />
              : inProgress
                ? <MobileGenerating onBack={back} projectName={project.name} />
                : filmUnknown
                  ? <PreviewLoading onBack={back} projectId={project.id} projectName={project.name} />
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
          </SwipeBack>
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
        {/* 「字幕」抽屉只管字幕：预览将烧录的每一行 + 时间轴 + 高度/字号。
            withVoicePanel={false} ——配音有它自己的抽屉，别把同一块面板
            在两个入口里各显示一次（之前两个抽屉长得一模一样就是这个原因）。 */}
        <div className="h-[46vh]"><SubtitleList withVoicePanel={false} /></div>
        <div className="mt-3 border-t border-line pt-3"><SubtitleHeight /></div>
        {/* 封面标题也放「字幕」抽屉——它俩都是"片子上的字"，用户会在同一个
            心智里找它；单开一个抽屉只会让底栏多一个用一次的图标 */}
        <div className="mt-3 border-t border-line pt-3"><CoverPanel /></div>
      </BottomSheet>

      <BottomSheet open={sheet === 'background'} onClose={back} title={SHEET_TITLE.background}>
        <BackgroundPanel />
      </BottomSheet>

      <BottomSheet open={sheet === 'music'} onClose={back} title={SHEET_TITLE.music}>
        <MusicPanel />
      </BottomSheet>

      {/* 拖字幕滑块时浮在画面正中的读数：界面都淡掉了，
          没个数字用户不知道自己调到哪儿了 */}
      <ScrubReadout />
      <AppUpdateBanner />
      <VersionBadge />
    </div>
  )
}

/**
 * 成片状态还没问出来时的过渡屏：**直接把成片第一帧铺满**。
 *
 * 封面接口（/film/poster.jpg）只在母带确实躺在盘上时才返回图片，所以
 * 「图加载成功」本身就是一个可靠的信号：这个项目有成片。据此才点亮右上角
 * 的下载键——不猜、不画一个点下去会 404 的按钮。
 *
 * 图没出来的那一小会儿只有一个转圈，不写任何"还没有成片"之类的话：
 * 状态未知时说出来的判断，有一半概率是错的。
 */
function PreviewLoading ({ onBack, projectId, projectName }: {
  onBack: () => void; projectId: string; projectName: string
}) {
  const [hasFrame, setHasFrame] = useState(false)
  const [noFrame, setNoFrame] = useState(false)
  return (
    <div className="absolute inset-0 bg-black">
      <img
        src={`/api/projects/${projectId}/film/poster.jpg`}
        alt=""
        onLoad={() => setHasFrame(true)}
        onError={() => setNoFrame(true)}
        className="absolute inset-0 size-full object-contain object-top sj-fade"
        style={{ opacity: hasFrame ? 1 : 0, transition: 'opacity 260ms ease' }}
      />

      {!hasFrame && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
          <IconLoader className="size-6 animate-spin text-ink-600" />
          {/* 封面取不到（还没合出来，或网络不通）也只说"在读"，不下结论 */}
          <span className="text-xs text-ink-400">{noFrame ? '正在读取项目…' : '正在载入预览…'}</span>
        </div>
      )}

      <div className="absolute inset-x-0 z-20 flex items-center justify-between px-4" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-full border border-white/15 bg-black/65 px-3.5 py-2 text-sm font-semibold text-white"
        >
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
          <span className="max-w-[46vw] truncate">{projectName}</span>
          <IconChevronDown className="size-3.5 opacity-70" strokeWidth={2} />
        </button>

        {hasFrame && (
          <a
            href={`/api/projects/${projectId}/film/download`}
            aria-label="下载视频"
            className="flex size-10 items-center justify-center rounded-full bg-accent text-ink-950 shadow-lg shadow-black/30"
          >
            <IconDownload className="size-5" strokeWidth={2.2} />
          </a>
        )}
      </div>
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
