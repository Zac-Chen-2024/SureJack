import { useEffect, useState, type ReactNode } from 'react'
import { useProjects } from '../store/projects'
import { usePipeline } from '../store/pipeline'
import { useSubtitles } from '../store/subtitles'
import { useLibrary } from '../store/library'
import { ProjectSwitcher } from '../components/ProjectSwitcher'
import { ScriptEditor } from '../components/ScriptEditor'
import { SubtitleList } from '../components/SubtitleList'
import { AssetPanel } from '../components/AssetPanel'
import { Preview } from '../components/Preview'
import { FilmPlayer } from '../components/FilmPlayer'
import { useFilmStatus } from '../hooks/useFilmStatus'
import { SubtitleHeight } from '../components/SubtitleHeight'
import { ExportPanel } from '../components/ExportPanel'
import { AmbientBackdrop } from '../components/AmbientBackdrop'
import { AccountMenu } from '../components/AccountMenu'
import { BUILD_SHA, buildTimeLocal } from '../build-info'
import {
  IconChevronRight, IconChevronDown, IconPlay,
} from '../components/ui/Icon'

/**
 * 三栏工作台：**说什么 → 出来什么（以及用了什么料）**。
 *
 *   ┌──────┬────────┬────────────┬──────────────┐
 *   │ 项目 │ 设置    │  9:16 预览  │  文案编辑     │
 *   │ 列表 │ 字幕高度│            │  ───────────  │
 *   │      │ 背景    │            │  配音 + 字幕  │
 *   │      │ 音乐/音量│  [导出]    │              │
 *   │ 180  │  200   │ 300-380    │ minmax(0,1fr)│
 *   └──────┴────────┴────────────┴──────────────┘
 *
 * 整体限宽 1200 居中，两侧留白铺细斜纹 + 随时间变化的问候语。
 *
 * ── 为什么从四栏收成三栏 ─────────────────────────────────────────────
 * 原来「素材」自成一栏，是因为那时候背景视频要用户上传。现在背景是从
 * 素材库按三段式公式**全自动**拼的，人只需要选一首背景音乐、拖一下音量——
 * 一整栏的宽度配不上这点操作量。留着它只会让人以为那里有事要做。
 *
 * 收掉之后素材并进预览那栏：那一栏的意思变成「出来什么 + 用了什么料」，
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


  /*
   * 文案区展开/收起，**默认折叠**。
   *
   * 文案通常写一次就不动了；打开工作台之后大部分时间是在核对字幕、
   * 调设置、看预览。默认收起让字幕吃满整栏，要改文案时点一下即可。
   * 收起态的那行会显示字数，所以"里面有没有东西"仍然一眼可见。
   */
  const [scriptOpen, setScriptOpen] = useState(false)

  /*
   * 成片合好了没有。ExportPanel 已经在轮询这个状态，这里只是读同一份
   * store——不要另起一轮轮询，两轮问同一个接口会互相看到对方排的活。
   */
  const filmReady = usePipeline((s) => s.film?.state === 'ready')
  /*
   * 轮询挂在【整栏都在的地方】，不能挂在下面那两个会互相顶替的组件里：
   * 成片一好 ExportPanel 就整块不渲染了，轮询跟着断，之后用户改文案
   * 让成片作废也不会有人去问一句"现在怎么样了"。
   */
  useFilmStatus(project ?? null)




  /*
   * 栅格。两个数字定死、一个 1fr 吸收余量：
   *   - 项目列表 240（收起 3.5rem）：放得下项目名，再宽就是浪费
   *   - 文案 + 字幕列 minmax(0,1fr)：多出来的宽度全给写字的地方，这是主战场。
   *     下限写 0 而不是 420，是为了让窄屏"挤一挤"而不是顶出横向滚动条——
   *     正文本来就会换行，横向滚动才是真的没法用。
   *   - 预览 + 素材列 minmax(380,460)：比原来的预览栏宽一点（要多装素材设置），
   *     但仍给上限，否则 2560 宽的屏上它会大到喧宾夺主。
   */
  /*
   * 【预览在中、文案在右】：预览是定宽的，夹在两个位置固定的东西
   * （项目列表、屏幕右边缘）之间会让它左右都不着力。放中间之后，
   * 它左边贴着同样定宽的项目列表，右边是唯一会伸缩的文案栏——
   * 拉窗口时只有文案在变，视觉上稳得多。
   *
   * ⚠️ 栅格按 DOM 顺序排列，所以下面两个 section 的书写顺序也必须
   * 跟着换：预览那节在前、文案那节在后。
   */
  const cols = 'grid-cols-[25%_minmax(0,1fr)_25%]'

  return (
    /*
     * 整个工作台限宽居中，两侧留白。
     *
     * 【为什么不铺满】：三栏铺满 1920 时，文案栏能到 1200px 宽——一行排到
     * 七八十个汉字，读起来要来回甩头，而且屏幕最外侧那两条其实什么都没有。
     * 铺满不等于用得上。
     *
     * 1200px 上限在 1920 屏上是每边 18.75% 的留白，接近对半分的视觉舒适区；
     * 1200 及以下则自动铺满，小屏不会被凭空挤掉宽度。
     *
     * 外层保留 bg-ink-950，留白区域和最深的那栏同色——不然会看出一个
     * 悬浮的方块，那不是想要的效果。
     */
    <div className="relative flex h-full justify-center bg-ink-950">
      <AmbientBackdrop />
      {/*
        版本角标固定在【屏幕】右下角，不在任何一栏里。
        它是排查用的锚点、不属于任何功能区；挂在栏内会被误读成
        那一栏的一部分。fixed + 极低对比，需要时找得到、平时不占注意力。
      */}
      <div
        className="pointer-events-none fixed bottom-2 right-3 z-30 text-[10px] tabular-nums text-ink-600"
        title={`构建版本 ${BUILD_SHA}\n构建时间 ${buildTimeLocal()}`}
      >
        {BUILD_SHA} · {buildTimeLocal()}
      </div>
      <div className={`relative grid h-full w-full max-w-[1200px] border-x border-line bg-ink-950 ${cols}`}>

      {/*
        ② 用什么料 —— 字幕高度、背景、背景音乐、音量，全部的调节项。
        从预览栏里抽出来单独成一列：预览就该是纯预览，一屏里既有画面
        又堆着四五个控件时，眼睛不知道该看哪儿。设置独立之后，
        看画面和调参数是两件分开的事，各有各的地盘。
      */}
      <section className="flex min-h-0 min-w-0 flex-col border-r border-line bg-ink-900">
        {/* 题头就是项目切换器：当前项目名 + 点击向下展开列表 */}
        <ProjectSwitcher />
        {project ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <SubtitleHeight />
            <div className="mt-4 border-t border-line pt-4">
              <AssetPanel />
            </div>
          </div>
        ) : <div className="min-h-0 flex-1"><NeedProject /></div>}
        {/*
          账号常驻这一栏底部。它和项目切换器一头一尾，把这栏framed成
          「你是谁 / 你在哪 / 你能调什么」——原来那一整栏项目列表
          干的就是前两件事，收进来之后省下 180px 给真正在用的地方。
        */}
        <div className="flex shrink-0 items-center border-t border-line p-2">
          <AccountMenu />
        </div>
      </section>

      {/* ③ 出来什么 —— 纯预览，导出常驻底部 */}
      <section className="flex min-h-0 min-w-0 flex-col border-r border-line bg-ink-900">
        <ColumnHeader icon={<IconPlay className="size-4 text-ink-400" />}>预览</ColumnHeader>
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

                所以按【视口高度】限宽。设置项已经搬到独立一栏，这一栏只剩
                预览和导出，可以给画面更多空间：38vh 宽 ≈ 68vh 高，
                加上列头 56 + 播放条 40 + 导出区 90，1000px 高的窗口仍装得下。
                用 vh 而不是写死像素，笔记本和大屏上都成立。
              */}
              {/*
                【成片好了就播成片】。

                Preview 是在前端现拼一个近似品（背景轨 + 配音 + BGM + JASSUB
                字幕，四层叠着播）。那套东西存在的理由是当年成片要手动导出、
                必须先有个东西给人看。现在成片是自动合的，盘上躺着真东西时
                再拼近似品，只会制造"预览和成片哪个才对"这类查不清的差异。

                所以 ready 之后一律换成 FilmPlayer——一个 <video>，播的就是
                将要下载的那个文件。现拼那条路只在【还没合完】时兜底，
                让用户在等的时候不至于对着一块空白。
              */}
              <div className="mx-auto w-full max-w-[min(100%,46vh)]">
                {filmReady ? (
                  <FilmPlayer
                    onTimeChange={setCurrentMs}
                    seek={seekNonce > 0 ? { ms: currentMs, nonce: seekNonce } : null}
                  />
                ) : (
                  <Preview
                    onTimeChange={setCurrentMs}
                    seek={seekNonce > 0 ? { ms: currentMs, nonce: seekNonce } : null}
                  />
                )}
              </div>

            </div>
            {/*
              【成片好了就没有这一块了】。下载、进度、重新合成全都并进了
              播放器自己那条控制栏（见 FilmPlayer），这里再留一块就是
              把同一件事说两遍，还白吃掉一百多像素的画面高度。

              没合完时它才出现——那时候它说的是另一件事：还要等多久。
            */}
            {!filmReady && (
              <div className="shrink-0 border-t border-line p-4"><ExportPanel /></div>
            )}
          </>
        ) : <NeedProject />}
      </section>
      {/* ④ 说什么 —— 上半文案编辑，下半「配音 + 字幕」。
          这一列是三栏里唯一用 ink-950 的，最深的那块就是让人写字的地方。 */}
      <section className="flex min-h-0 min-w-0 flex-col bg-ink-950">
        <ColumnHeader>文本</ColumnHeader>
        {/*
          【字幕在上、文案在下】，且文案可收起。

          文案通常写一次就不动了，之后大部分时间是在核对字幕和时间点——
          让常看的那个占据视线自然落点（上半），把写完就搁置的收到下面。

          文案收起时字幕吃满整栏：不写死高度，用 grid-rows 的 auto 让
          收起后的文案条只占它自己那点高度，剩下全归字幕。
        */}
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateRows: scriptOpen
              ? 'minmax(0,1fr) minmax(0,1fr)'
              : 'minmax(0,1fr) auto',
          }}
        >
          <div className="min-h-0"><SubtitleList /></div>
          <div className="flex min-h-0 flex-col border-t border-line">
            <button
              type="button"
              onClick={() => setScriptOpen((v) => !v)}
              className="flex h-10 shrink-0 items-center gap-1.5 px-4 text-left text-xs text-ink-400 hover:text-ink-100"
              title={scriptOpen ? '收起文案' : '展开文案'}
            >
              {scriptOpen
                ? <IconChevronDown className="size-3.5" />
                : <IconChevronRight className="size-3.5" />}
              文案
              {/* 收起时把字数带出来——收起了也该知道里面有没有东西 */}
              {!scriptOpen && project?.scriptText
                ? <span className="tabular-nums text-ink-600">{[...project.scriptText].length} 字</span>
                : null}
            </button>
            {scriptOpen && <div className="min-h-0 flex-1 px-6 pb-4"><ScriptEditor /></div>}
          </div>
        </div>
      </section>

      </div>
    </div>
  )
}
