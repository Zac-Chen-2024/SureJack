import { useEffect } from 'react'
import { AudioMix } from './AudioMix'
import { useProjects } from '../store/projects'
import {
  useLibrary, parseBgmName, groupPhases, segmentShares, describePlan, formatClock,
} from '../store/library'
import { IconFilm, IconMusic, IconLoader } from './ui/Icon'

/**
 * 素材区。**这里没有上传。**
 *
 * 素材是 data/library/ 里那 210 个本地文件，用户只能选、不能传——
 * 任何一个「上传」按钮都会重新打开一条这个产品不想要的路。
 *
 * 两件事，重量差别很大：
 *   - 背景视频【全自动】：按三段式公式从素材库现拼，没有任何可操作项，
 *     所以它只是一条分段条 + 一行字，看起来就该是全自动的。
 *   - 背景音乐【要选】：9 选 1，是这一区唯一真正的交互。
 */

/** 小节标题。整个素材区靠这一种标题统一节奏 */
function SectionLabel ({ icon, children, trailing }: {
  icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
      {icon}{children}
      {trailing !== undefined && <span className="ml-auto normal-case">{trailing}</span>}
    </div>
  )
}

/**
 * 三段式背景的分段条。
 *
 * 三段用【同一个强调色的三档明度】而不是三种颜色：它们是同一件事的三个
 * 阶段（开头 → 常规 → 地铁跑酷），不是三个并列的类别。三种颜色会读作
 * "三个不相干的东西"，明度阶梯才读作"一条被切成三段的时间轴"。
 * 也因此不引入任何新色号。
 */
const SEGMENT_TINTS = ['bg-accent', 'bg-accent/60', 'bg-accent/30']

function BackgroundStrip ({ projectId }: { projectId: string }) {
  const plan = useLibrary((s) => s.plan)
  const loading = useLibrary((s) => s.planLoading)
  const error = useLibrary((s) => s.planError)
  const loadPlan = useLibrary((s) => s.loadPlan)
  const ttsDurationMs = useProjects((s) => s.current()?.ttsDurationMs ?? null)

  /*
   * 排布长度完全由配音决定，所以配音一变（时长从 null 变成数字、
   * 重新生成后时长变了）就得重算。只依赖 projectId 的话，用户刚生成完
   * 配音，分段条还停在「等配音」，看着像坏了。
   */
  useEffect(() => { void loadPlan(projectId) }, [projectId, ttsDurationMs, loadPlan])

  /*
   * 后端回的是 38 个几秒长的源片段，不是三段——三段式说的是三个【阶段】。
   * 先合并成阶段再画，否则这条 1.5px 高的轨会变成几十条头发丝。
   */
  const phases = groupPhases(plan?.segments ?? [])
  const shares = segmentShares(phases)

  return (
    <div>
      <SectionLabel
        icon={<IconFilm className="size-3.5" />}
        trailing={loading
          ? <IconLoader className="size-3 animate-spin" />
          : phases.length > 0
            ? <span className="tabular-nums text-ink-400">{formatClock(plan?.totalMs ?? 0)}</span>
            : null}
      >
        背景 · 自动
      </SectionLabel>

      {error !== null ? (
        <p className="text-[11px] leading-relaxed text-ink-400">{error}</p>
      ) : phases.length === 0 ? (
        <>
          {/* 空态也画一条槽：让人先看见"这里会有一条东西"，
              而不是一段孤零零的解释文字 */}
          <div className="h-1.5 rounded-full bg-ink-700" />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
            生成配音后按时长自动排布。
          </p>
        </>
      ) : (
        <>
          <div className="flex h-1.5 gap-0.5 overflow-hidden">
            {phases.map((phase, i) => (
              <div
                key={phase.bucket}
                // 首尾各圆一头，中间方头：三段拼起来仍读作一条完整的轨
                className={[
                  SEGMENT_TINTS[i % SEGMENT_TINTS.length],
                  i === 0 ? 'rounded-l-full' : '',
                  i === phases.length - 1 ? 'rounded-r-full' : '',
                ].join(' ')}
                style={{ width: `${shares[i] ?? 0}%` }}
              />
            ))}
          </div>
          {/* 只说"每段多长、是哪个桶"。不列片段、不给重选——
              全自动的东西就该看起来全自动 */}
          <p className="mt-1.5 text-[11px] leading-relaxed tabular-nums text-ink-400">
            {describePlan(phases)}
          </p>
        </>
      )}
    </div>
  )
}

/** BGM 单选：9 选 1，外加一个「不要」 */
function BgmPicker () {
  const project = useProjects((s) => s.current())
  const setBgm = useProjects((s) => s.setBgm)
  const items = useLibrary((s) => s.bgm)
  const loading = useLibrary((s) => s.bgmLoading)
  const error = useLibrary((s) => s.error)
  const loadBgm = useLibrary((s) => s.loadBgm)

  // 素材库是全局公用的，一次会话取一次就够，不跟着项目走
  useEffect(() => { if (items.length === 0) void loadBgm() }, [items.length, loadBgm])

  const selected = project?.bgmLibraryId ?? null

  return (
    <div>
      <SectionLabel
        icon={<IconMusic className="size-3.5" />}
        trailing={loading ? <IconLoader className="size-3 animate-spin" /> : null}
      >
        背景音乐
      </SectionLabel>

      {error !== null && <p className="text-[11px] leading-relaxed text-ink-400">{error}</p>}

      <div
        role="radiogroup"
        aria-label="背景音乐"
        // 九首 + 一个「不要」在窄栏里放不下，给一个自己的滚动区，
        // 不让它把整条右栏顶长
        className="max-h-44 space-y-0.5 overflow-y-auto"
      >
        <BgmOption
          title="不用背景音乐" tags=""
          checked={selected === null}
          onSelect={() => { void setBgm(null) }}
        />
        {items.map((item) => {
          const { title, tags } = parseBgmName(item.filename)
          return (
            <BgmOption
              key={item.id}
              title={title} tags={tags}
              duration={formatClock(item.durationMs)}
              checked={selected === item.id}
              onSelect={() => { void setBgm(item.id) }}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * 一个 BGM 选项。用 role="radio" 的按钮而不是原生 input：
 * 选中态要染整行（左侧那条 2px 竖条 + 底色），原生单选点在深色下
 * 既难看又要写四套浏览器伪元素样式。语义靠 role + aria-checked 补齐。
 */
function BgmOption ({ title, tags, duration, checked, onSelect }: {
  title: string; tags: string; duration?: string; checked: boolean; onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={[
        // 竖条在未选中时也占位（透明），否则选中时整行文字横向抖 2px
        'flex w-full items-baseline gap-2 border-l-2 py-1 pr-2 pl-2 text-left',
        checked ? 'border-accent bg-ink-700' : 'border-transparent hover:bg-ink-850',
      ].join(' ')}
    >
      <span className="shrink-0 text-xs text-ink-100">{title}</span>
      {/* 标签是次要信息：小一号、压暗，跟在曲名右边，不抢曲名 */}
      {tags !== '' && <span className="min-w-0 flex-1 truncate text-[11px] text-ink-400">{tags}</span>}
      {duration !== undefined && (
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-400">{duration}</span>
      )}
    </button>
  )
}

/*
 * 【原来这儿有个 VolumeSlider——只能调背景音乐、显示一个没头没尾的百分比】。
 * 删了，换成 AudioMix：配音和音乐两条轨各自带波形、响度读数和滑块，
 * 并把平台基准（-14 LUFS）摆出来。用户报的"声音小且不可调"，
 * 一半是真的调不了（配音没有入口），一半是不知道该调到哪儿。
 */

export function AssetPanel () {
  const project = useProjects((s) => s.current())
  if (!project) return null

  return (
    <div className="space-y-4">
      <BackgroundStrip projectId={project.id} />
      <BgmPicker />
      <AudioMix />
    </div>
  )
}

/**
 * 手机版把素材区拆成两个底部抽屉——「背景」和「音乐」各一个入口
 * （照概念图的五格底栏）。桌面仍是一整块 AssetPanel，这里只是把同样的
 * 内部块重新分组导出，逻辑一行不改。
 */
export function BackgroundPanel () {
  const project = useProjects((s) => s.current())
  if (!project) return null
  return <BackgroundStrip projectId={project.id} />
}

/**
 * 「音频」抽屉：选背景音乐 + 两条轨的波形/响度/音量。
 *
 * 【原来叫「音乐」，改名是因为它管的东西变了】：以前只有背景音乐能调，
 * 配音的音量根本没有入口——而用户报的正是"声音小且不可调"。
 * 现在配音和音乐是两条平等的轨，名字得跟上。
 */
export function MusicPanel () {
  const project = useProjects((s) => s.current())
  if (!project) return null
  return (
    <div className="space-y-4">
      <BgmPicker />
      <AudioMix />
    </div>
  )
}
