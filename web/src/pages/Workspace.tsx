import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSession } from '../store/session'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { ProjectList } from '../components/ProjectList'
import { ScriptEditor } from '../components/ScriptEditor'
import { SubtitleList } from '../components/SubtitleList'
import { AssetPanel } from '../components/AssetPanel'
import { VoicePanel } from '../components/VoicePanel'
import { Preview } from '../components/Preview'
import { ExportPanel } from '../components/ExportPanel'
import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
import {
  IconChevronLeft, IconChevronRight, IconLogOut, IconPlay, IconUpload, IconVolume,
} from '../components/ui/Icon'

/**
 * 四栏工作台。从左到右正好是制作流程：**说什么 → 用什么 → 出来什么**。
 *
 *   ┌────────┬─────────────┬────────┬──────────┐
 *   │ 项目   │  文案编辑    │ 背景视频│  9:16    │
 *   │ 列表   ├─────────────┤ 背景音乐│  预览     │
 *   │(可折叠)│ 时间·字幕    │ 配音    │ [导出]   │
 *   │  240   │    1fr      │  260   │ 340-420  │
 *   └────────┴─────────────┴────────┴──────────┘
 *
 * 为什么用 CSS Grid 而不是嵌套 flex：四栏的宽度关系是**一句话**能说清的事
 * （见下面的 grid-cols-[...]）。用 flex 就得靠 w-64 / flex-1 / w-72 散落在
 * 三四层 DOM 里，改一栏宽度要翻遍整棵树才敢动。栅格把布局约束集中到了一处。
 *
 * 分栏只靠 border-line 这条极细描边 + 背景色差，不用粗分隔线——深色 UI 里
 * 一条 6% 白的描边就足够"接住光"，画粗线反而把四栏切成四个不相干的窗口。
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
  useEffect(() => {
    if (project?.id) { resetPipeline(); void loadAssets(project.id) }
  }, [project?.id, loadAssets, resetPipeline])

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
   * 栅格。三个数字定死、一个 1fr 吸收余量：
   *   - 项目列表 240（收起 3.5rem）：放得下项目名，再宽就是浪费
   *   - 文案列 minmax(0,1fr)：多出来的宽度全给写字的地方，这是主战场。
   *     下限写 0 而不是 420，是为了让窄屏"挤一挤"而不是顶出横向滚动条——
   *     正文本来就会换行，横向滚动才是真的没法用。
   *   - 素材列 260：两个上传槽 + 配音状态，固定宽度反而稳定
   *   - 预览列 minmax(340,420)：给上限，否则 2560 宽的屏上预览会大到喧宾夺主
   */
  const cols = collapsed
    ? 'grid-cols-[3.5rem_minmax(0,1fr)_260px_minmax(340px,420px)]'
    : 'grid-cols-[240px_minmax(0,1fr)_260px_minmax(340px,420px)]'

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

      {/* ② 说什么 —— 上半文案编辑，下半时间·字幕列表。
          这一列是四栏里唯一用 ink-950 的，最深的那块就是让人写字的地方。 */}
      <section className="flex min-h-0 min-w-0 flex-col border-r border-line bg-ink-950">
        <ColumnHeader>{project?.name ?? '选一个项目开始'}</ColumnHeader>
        {/* 上下各占一半，中间一条 border-line。两行都写 minmax(0,1fr)：
            不写 0 下限的话，子元素内容一多就会把行撑高，"一半"就名存实亡了 */}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-h-0 px-6 pb-4 pt-4"><ScriptEditor /></div>
          <div className="min-h-0 border-t border-line"><SubtitleList /></div>
        </div>
      </section>

      {/* ③ 用什么 —— 素材与配音。AssetPanel 本来就没有自己的外层卡片
          （只是个 space-y 堆叠），直接放进来即可，整个一列就是它的容器。 */}
      <section className="flex min-h-0 min-w-0 flex-col border-r border-line bg-ink-900">
        <ColumnHeader icon={<IconUpload className="size-4 text-ink-400" />}>素材</ColumnHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {project ? (
            <div className="space-y-5">
              <AssetPanel />
              <VoicePanel />
              {/*
                TODO(后续)：音量平衡滑杆。后端 projects.bgm_volume 已存在
                （src/db/user-db.ts，默认 0.1，导出时经 buildAudioFilter 生效），
                但前端 Project 类型里还没有这个字段，PATCH 也没接。
                补齐前不放假滑杆——一个拖不动的控件比没有控件更让人困惑。
              */}
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
                  <IconVolume className="size-3.5" />音量平衡
                </div>
                <p className="text-[11px] leading-relaxed text-ink-400">
                  背景音乐按默认音量混入，暂不可调。
                </p>
              </div>
            </div>
          ) : <NeedProject />}
        </div>
      </section>

      {/* ④ 出来什么 —— 预览在上，导出在下 */}
      <section className="flex min-h-0 min-w-0 flex-col bg-ink-900">
        <ColumnHeader icon={<IconPlay className="size-4 text-ink-400" />}>预览</ColumnHeader>
        {project ? (
          <>
            <Preview />
            {/* 导出常驻底部，不参与上面预览框的高度竞争——它是这一栏的落点 */}
            <div className="shrink-0 border-t border-line p-4"><ExportPanel /></div>
          </>
        ) : <NeedProject />}
      </section>
    </div>
  )
}
