import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSession } from '../store/session'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { ProjectList } from '../components/ProjectList'
import { ScriptEditor } from '../components/ScriptEditor'
import { SubtitleList } from '../components/SubtitleList'
import { AssetPanel } from '../components/AssetPanel'
import { Preview } from '../components/Preview'
import { ExportPanel } from '../components/ExportPanel'
import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
import {
  IconChevronLeft, IconChevronRight, IconLogOut, IconPlay,
} from '../components/ui/Icon'

/**
 * 三栏工作台：**说什么 → 出来什么（以及用了什么料）**。
 *
 *   ┌────────┬──────────────────┬──────────────────┐
 *   │ 项目   │  文案编辑         │   9:16 预览       │
 *   │ 列表   │  ──────────────  │  ──────────────  │
 *   │(可折叠)│  配音 + 字幕      │  背景（自动）     │
 *   │        │                  │  背景音乐 / 音量  │
 *   │  240   │   minmax(0,1fr)  │  minmax(380,460) │
 *   └────────┴──────────────────┴──────────────────┘
 *
 * ── 为什么从四栏收成三栏 ─────────────────────────────────────────────
 * 原来「素材」自成一栏，是因为那时候背景视频要用户上传。现在背景是从
 * 素材库按三段式公式**全自动**拼的，人只需要选一首背景音乐、拖一下音量——
 * 一整栏的宽度配不上这点操作量。留着它只会让人以为那里有事要做。
 *
 * 收掉之后素材并到右栏：右栏的意思变成「出来什么 + 用了什么料」，
 * 预览在上占大头，素材设置在下且紧凑。腾出的宽度全给了文案栏，
 * 那才是主战场。
 *
 * 为什么用 CSS Grid 而不是嵌套 flex：三栏的宽度关系是**一句话**能说清的事
 * （见下面的 grid-cols-[...]）。用 flex 就得靠 w-64 / flex-1 / w-72 散落在
 * 三四层 DOM 里，改一栏宽度要翻遍整棵树才敢动。栅格把布局约束集中到了一处。
 *
 * 分栏只靠 border-line 这条极细描边 + 背景色差，不用粗分隔线——深色 UI 里
 * 一条 6% 白的描边就足够"接住光"，画粗线反而把三栏切成三个不相干的窗口。
 */

/** 宽度低于这个值，项目列表自动收起——切项目的频率远低于编辑，先让出这 240px */
const NARROW = '(max-width: 1400px)'

/** 各列共用的列头，高度对齐成一条横向的头部带 */
function ColumnHeader ({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-4 text-sm font-medium text-ink-100">
      {icon}{children}
    </div>
  )
}

/** 没选项目时，右侧两栏不该是一片空白 */
function NeedProject () {
  return <div className="p-4 text-xs text-ink-400">先在左侧选一个项目。</div>
}

export function Workspace () {
  const { name, logout } = useSession()
  const { load, current } = useProjects()
  useEffect(() => { load() }, [load])
  const project = current()

  const loadAssets = usePipeline((s) => s.loadAssets)
  const resetPipeline = usePipeline((s) => s.reset)
  // 背景排布是按项目 id 算的种子随机，切项目必须先清掉——
  // 否则新项目会先闪一下上一个项目的分段条
  const resetPlan = useLibrary((s) => s.resetPlan)
  useEffect(() => {
    if (project?.id) { resetPipeline(); resetPlan(); void loadAssets(project.id) }
  }, [project?.id, loadAssets, resetPipeline, resetPlan])

  /*
   * 字幕是【派生】数据：后端每次从项目存下的词时间轴现推，不入库。
   * 所以除了切项目要重取，配音状态一变（none → ready）也必须重取——
   * 否则用户刚生成完配音，字幕列表还是空的，看着像功能坏了。
   * 这就是把 ttsState 放进依赖数组的原因。
   */
  const loadSubtitles = useSubtitles((s) => s.load)
  const resetSubtitles = useSubtitles((s) => s.reset)
  const setCurrentMs = useSubtitles((s) => s.setCurrentMs)
  const currentMs = useSubtitles((s) => s.currentMs)
  const seekNonce = useSubtitles((s) => s.seekNonce)
  useEffect(() => {
    if (!project?.id) { resetSubtitles(); return }
    void loadSubtitles(project.id)
  }, [project?.id, project?.ttsState, loadSubtitles, resetSubtitles])

  // 初值直接问 matchMedia，避免"先展开再抽搐着收起"的首帧闪烁
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(NARROW).matches)

  /*
   * 用户一旦亲手点过这个按钮，窗口再怎么变宽变窄都不再自动收放。
   * 自动行为覆盖用户的显式操作是很烦人的体验：他明明是特意展开来找项目的，
   * 结果拖一下窗口又被收回去了。用 ref 而不是 state——它只用来在事件回调里
   * 做判断，不需要触发重渲染。
   */
  const userDecided = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const onChange = (e: MediaQueryListEvent) => {
      if (!userDecided.current) setCollapsed(e.matches)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const toggle = useCallback(() => {
    userDecided.current = true
    setCollapsed((c) => !c)
  }, [])

  /*
   * 栅格。两个数字定死、一个 1fr 吸收余量：
   *   - 项目列表 240（收起 3.5rem）：放得下项目名，再宽就是浪费
   *   - 文案 + 字幕列 minmax(0,1fr)：多出来的宽度全给写字的地方，这是主战场。
   *     下限写 0 而不是 420，是为了让窄屏"挤一挤"而不是顶出横向滚动条——
   *     正文本来就会换行，横向滚动才是真的没法用。
   *   - 预览 + 素材列 minmax(380,460)：比原来的预览栏宽一点（要多装素材设置），
   *     但仍给上限，否则 2560 宽的屏上它会大到喧宾夺主。
   */
  const cols = collapsed
    ? 'grid-cols-[3.5rem_minmax(0,1fr)_minmax(380px,460px)]'
    : 'grid-cols-[240px_minmax(0,1fr)_minmax(380px,460px)]'

  return (
    <div className={`grid h-full ${cols}`}>
      {/* ① 项目列表 —— 可折叠 */}
      <aside className="flex min-w-0 flex-col border-r border-line bg-ink-900">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-3">
          {!collapsed && <span className="text-sm font-semibold tracking-[-0.02em] text-ink-50">SureJack</span>}
          <button
            onClick={toggle}
            className="flex items-center justify-center rounded-lg p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            title={collapsed ? '展开项目列表' : '收起项目列表'}
          >
            {collapsed ? <IconChevronRight className="size-4" /> : <IconChevronLeft className="size-4" />}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {!collapsed && <ProjectList />}
        </div>
        {/* 折叠时只留头像——收起状态下它是唯一还能表明「你是谁」的元素 */}
        <div className="shrink-0 border-t border-line p-2">
          {collapsed ? (
            <div className="flex justify-center py-1">
              <Avatar name={name ?? ''} />
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2.5 px-1.5 py-1">
                <Avatar name={name ?? ''} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">{name}</span>
              </div>
              <Button className="w-full justify-start" onClick={logout}>
                <IconLogOut className="size-4" /> 登出
              </Button>
            </>
          )}
        </div>
      </aside>

      {/* ② 说什么 —— 上半文案编辑，下半「配音 + 字幕」。
          这一列是三栏里唯一用 ink-950 的，最深的那块就是让人写字的地方。 */}
      <section className="flex min-h-0 min-w-0 flex-col border-r border-line bg-ink-950">
        <ColumnHeader>{project?.name ?? '选一个项目开始'}</ColumnHeader>
        {/* 上下各占一半，中间一条 border-line。两行都写 minmax(0,1fr)：
            不写 0 下限的话，子元素内容一多就会把行撑高，"一半"就名存实亡了 */}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-h-0 px-6 pb-4 pt-4"><ScriptEditor /></div>
          <div className="min-h-0 border-t border-line"><SubtitleList /></div>
        </div>
      </section>

      {/* ③ 出来什么 + 用了什么料 —— 预览在上，素材在下，导出常驻底部 */}
      <section className="flex min-h-0 min-w-0 flex-col bg-ink-900">
        <ColumnHeader icon={<IconPlay className="size-4 text-ink-400" />}>预览与素材</ColumnHeader>
        {project ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {/*
                预览和字幕列表的联动是【单向】的：音频是唯一时间源，只能由
                Preview 往 store 推 currentMs。绝不能反过来让 store 的 currentMs
                驱动音频——那会成环，进度条自己抖。

                反方向的「用户点字幕某一行要跳过去」走 seekNonce：只有序号变化
                才真跳转。否则播放中每帧 currentMs 都在变，会被误当成跳转指令，
                播放头被反复重置；而且连点同一行也仍然生效。
              */}
              {/*
                预览框是 9:16，高度 = 宽度 × 16/9。在 460px 的栏里铺满宽度会有
                818px 高，下面的背景音乐选择就整个被顶到屏幕外——而那是这一栏里
                唯一要人动手的东西，看不见等于没有。

                所以按【视口高度】限宽：26vh 宽 ≈ 46vh 高，1000px 高的窗口上
                预览下面还留得出背景条和几行选曲。用 vh 而不是写死像素，
                笔记本和大屏上都成立。
              */}
              <div className="mx-auto w-full max-w-[min(100%,26vh)]">
                <Preview
                  onTimeChange={setCurrentMs}
                  seek={seekNonce > 0 ? { ms: currentMs, nonce: seekNonce } : null}
                />
              </div>

              {/* 一条描边把「出来什么」和「用了什么料」分开，但仍在同一栏内 */}
              <div className="mt-4 border-t border-line pt-4">
                <AssetPanel />
              </div>
            </div>
            {/* 导出常驻底部，不参与上面的高度竞争——它是这一栏的落点 */}
            <div className="shrink-0 border-t border-line p-4"><ExportPanel /></div>
          </>
        ) : <NeedProject />}
      </section>
    </div>
  )
}
