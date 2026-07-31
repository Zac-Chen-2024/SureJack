import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects, type Project } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { AccountMenu } from '../AccountMenu'
import { PaletteToggle } from '../PaletteToggle'
import { DownloadPanel } from './DownloadPanel'
import {
  IconPlus, IconLoader, IconTrash, IconMore, IconFilter, IconSearch, IconClose,
  IconImage, IconImageOff, IconFolder,
} from '../ui/Icon'

/**
 * 手机版项目列表（概念图 Screen 0）：**我的项目 + 一步新建**。
 *
 * 每条一行：竖着的缩略图占位（成片是 9:16，用竖条呼应）+ 名字 + 一句摘要
 * + 右侧状态徽标（草稿 / 合成中 / 已完成）。状态是这屏的信息核心——它让
 * 用户不点进去就知道每个项目卡在哪一步。
 *
 * 版式分三层，从上到下【固定 → 固定 → 可滚】：
 *   ① 标题栏（下载队列 / 配色 / 账户）
 *   ② 新建项目按钮
 *   ③「最近」这行（筛选 + 搜索）+ 项目列表 ← 只有这层滚动、下拉刷新
 * 新建按钮【故意留在滚动区外】：它是常驻入口，下拉刷新时跟着被拽下去会散。
 *
 * 桌面用的是顶部的项目切换下拉；手机屏够高，直接铺成一整屏列表更好扫。
 */

/** 项目此刻处在哪一步。成片状态来自列表轮询（filmProgress） */
type Status = 'draft' | 'voicing' | 'render' | 'failed' | 'done'

function statusOf (p: Project, film?: { composing: boolean; state: string }): Status {
  if (film?.composing) return 'render'
  if (p.ttsState === 'generating') return 'voicing'
  /*
   * 【失败/取消必须盖过"配音已就绪"】。合成被取消或报错时配音本身还是好的，
   * 只看 ttsState 就会显示成「已完成」——和事实相反，用户会以为片子能下载。
   */
  if (p.ttsState === 'error' || film?.state === 'error') return 'failed'
  if (p.ttsState === 'ready') return 'done'
  return 'draft'
}

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'text-accent bg-accent/12' },
  // 两个"进行中"阶段共用琥珀（语义色，独立于冷/暖主题），靠标签区分；
  // 强调色留给"完成"。
  voicing: { label: '配音中', cls: 'text-[#e0a82e] bg-[#e0a82e]/12' },
  render: { label: '合成中', cls: 'text-[#e0a82e] bg-[#e0a82e]/12' },
  failed: { label: '未完成', cls: 'text-danger bg-danger/12' },
  draft: { label: '草稿', cls: 'text-ink-300 bg-ink-800' },
}

/** 一句摘要：文案开头 + 时长/状态。不堆细节，够一眼判断即可 */
function summaryOf (p: Project): string {
  const head = (p.scriptText ?? '').trim().replace(/\s+/g, '')
  const secs = p.ttsDurationMs ? Math.round(p.ttsDurationMs / 1000) : null
  const dur = secs !== null ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : null
  if (p.ttsState === 'ready') {
    const byo = p.subtitleMode === 'line' ? '自备配音' : '配音已生成'
    return [head ? head.slice(0, 12) : byo, dur].filter(Boolean).join(' · ')
  }
  if (head) return `仅文案 · 未配音`
  return '空项目 · 从这里开始'
}

/*
 * 【封面预览开关只存本地，不入库】。它回答的是"我现在想怎么看这个列表"，
 * 不是项目的属性——换台设备各看各的，也不该因为改了个显示偏好就去写数据库。
 */
const COVER_PREF_KEY = 'sj.list.cover'

function readCoverPref (): boolean {
  try { return localStorage.getItem(COVER_PREF_KEY) !== '0' } catch { return true }
}

/** 下拉多远算"要刷新"，以及指示条最多长到多高 */
const PULL_THRESHOLD = 56
const PULL_MAX = 76

export function MobileProjectList ({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const items = useProjects((s) => s.items)
  const remove = useProjects((s) => s.remove)
  const reload = useProjects((s) => s.load)
  const filmProgress = usePipeline((s) => s.filmProgress)

  // ── 筛选（还没做）/ 搜索（放大镜点开展成输入框）─────────────────
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [filterHint, setFilterHint] = useState(false)
  const [showCover, setShowCover] = useState(readCoverPref)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (searching) searchRef.current?.focus() }, [searching])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    // 名字和文案都搜——用户常常只记得片子里说了啥，不记得自己起的名字
    return items.filter((p) => p.name.toLowerCase().includes(q)
      || (p.scriptText ?? '').toLowerCase().includes(q))
  }, [items, query])

  /*
   * 【按母文件夹分组】。主片和续集是两个独立项目（各有各的配音、成片、
   * 下载），但用户心里它们是"同一个故事的两集"。所以列表上折成一组：
   * 组头是项目名，下面挂第 1 集、第 2 集。
   *
   * 排序仍然按主片的时间——续集是从主片派生出来的，让它自己去争列表顶端
   * 只会把同一个故事拆散在列表两头。
   */
  const grouped = useMemo(() => {
    const byParent = new Map<string, Project[]>()
    const mains: Project[] = []
    for (const p of shown) {
      if (p.parentProjectId) {
        const arr = byParent.get(p.parentProjectId) ?? []
        arr.push(p)
        byParent.set(p.parentProjectId, arr)
      } else {
        mains.push(p)
      }
    }
    const groups = mains.map((m) => ({
      main: m,
      episodes: (byParent.get(m.id) ?? []).sort((a, b) => a.episodeIndex - b.episodeIndex),
    }))
    /*
     * 搜索命中了续集、但主片被过滤掉时，续集会没有归属。别把它丢了——
     * 让它自己当一组的组头，总好过"搜得到却不显示"。
     */
    const orphans = [...byParent.entries()]
      .filter(([id]) => !mains.some((m) => m.id === id))
      .flatMap(([, arr]) => arr)
      .map((o) => ({ main: o, episodes: [] as Project[] }))
    return [...groups, ...orphans]
  }, [shown])


  /*
   * 【下拉刷新】。列表本来每 5 秒自动刷，但用户想"立刻知道现在怎么样了"时
   * 需要一个自己能触发的动作——干等着刷新是最让人不安的状态。
   * 只在已经滚到最顶(scrollTop<=0)时起手，否则会和正常的向下滚动打架。
   * 位移打 0.4 的阻尼并封顶，手感像原生而不是被手指拖着走。
   */
  const scrollRef = useRef<HTMLDivElement>(null)
  const pullStart = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  async function doRefresh () {
    setRefreshing(true)
    setPull(0)
    try { await reload() } finally {
      // 让"正在刷新"至少露一下脸；本地请求太快，一闪而过会像没反应
      setTimeout(() => setRefreshing(false), 420)
    }
  }

  const ready = pull >= PULL_THRESHOLD
  const dragging = pullStart.current !== null

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden bg-ink-950"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
    >
      {/* ── ① 标题栏（固定）───────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between px-5 pb-4">
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-50">我的项目</h2>
        <div className="flex items-center gap-1">
          {/* 下载队列：挨着账户头像，点开是进度悬浮框（安卓 App 内可用） */}
          <DownloadPanel />
          <PaletteToggle />
          <AccountMenu align="down-right" />
        </div>
      </div>

      {/* ── ② 新建项目（固定，下拉刷新时不动）─────────────────────── */}
      {/* pb 比标题栏略大：这里是"操作区"和"内容区"的分界。
          【但也别太大】——这条带子占的高度只该比搜索框本身多一点，
          留白撑得比它要分隔的东西还显眼，就本末倒置了 */}
      <div className="shrink-0 px-5 pb-4">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-accent py-4 text-[15px] font-extrabold text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconPlus className="size-5" strokeWidth={2.4} />
          新建项目
        </button>
      </div>

      {/* ── ③「最近」+ 筛选 / 搜索（固定，和列表同属下半区）───────── */}
      {/*
       * 【这行上下都要留白，且上大下小】。它是一条分隔带，不是列表的第一行：
       * 上面(16px)把它和"新建项目"这个操作区推开，下面(12px)小一点——
       * 留白不等宽，它才会读成"下面这堆东西的标题"，而不是飘在中间无所属。
       *
       * 整条带子连留白算下来 64px，搜索胶囊本身 32px——刚好比它宽一点。
       * 之前给到 32+36+20=88px，隔开的效果没变，只是把列表往下推了一截。
       */}
      <div className="mb-3 flex h-9 shrink-0 items-center gap-1.5 px-5">
        <span className="shrink-0 text-xs font-bold uppercase tracking-wider text-ink-400">最近</span>

        {/* 筛选：功能还没做，就明说，不摆一个装样子的按钮 */}
        <button
          type="button" aria-label="筛选"
          onClick={() => { setFilterHint(true); setTimeout(() => setFilterHint(false), 2400) }}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-200"
        >
          <IconFilter className="size-4" />
        </button>

        {/* 封面预览开关：挨着漏斗。做成图标按钮而不是滑动开关——
            这行只有 36px 高，塞一个 iOS 那种开关会把整行撑散。
            只存本地，不入库（见 COVER_PREF_KEY 上面那段） */}
        <button
          type="button"
          aria-label={showCover ? '关闭封面预览' : '显示封面预览'}
          aria-pressed={showCover}
          onClick={() => {
            const next = !showCover
            setShowCover(next)
            try { localStorage.setItem(COVER_PREF_KEY, next ? '1' : '0') } catch { /* 无痕模式写不了，不影响本次 */ }
          }}
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
            showCover ? 'text-accent hover:bg-ink-850' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200'
          }`}
        >
          {showCover ? <IconImage className="size-4" /> : <IconImageOff className="size-4" />}
        </button>

        {filterHint && !searching && (
          <span className="truncate text-[11px] text-[#e0a82e]">我还没开发呢，以后再开发</span>
        )}

        {/*
         * 【搜索是"原地拉开"，不是换一行】。放大镜这颗按钮本身长成胶囊：
         * 宽度 28px → 半行，只动 width 一个属性（避免布局抖动），
         * 输入框在拉开过程中淡入。这样视觉上是同一个东西展开了，
         * 而不是一个控件消失、另一个凭空出现。
         */}
        <div
          className="sj-motion sj-capsule ml-auto flex h-8 shrink-0 items-center overflow-hidden rounded-full border bg-ink-850"
          style={{
            width: searching ? '52%' : 28,
            borderColor: searching ? 'var(--color-line)' : 'transparent',
            backgroundColor: searching ? undefined : 'transparent',
            transition: 'width 340ms cubic-bezier(0.22,1,0.36,1), background-color 240ms ease, border-color 240ms ease',
          }}
        >
          <button
            type="button" aria-label={searching ? '搜索' : '打开搜索'}
            onClick={() => setSearching(true)}
            className={`flex size-7 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors ${searching ? '' : 'hover:bg-ink-850 hover:text-ink-200'}`}
          >
            <IconSearch className="size-4" />
          </button>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜名字或文案"
            tabIndex={searching ? 0 : -1}
            className="min-w-0 flex-1 bg-transparent pr-1 text-xs text-ink-50 caret-accent outline-none placeholder:text-ink-600"
            style={{
              // 比宽度动画晚一点点淡入，等胶囊拉开了字才出现，不然会挤在一起
              opacity: searching ? 1 : 0,
              transition: 'opacity 200ms ease 120ms',
            }}
          />
          {searching && (
            <button
              type="button" aria-label="关闭搜索"
              onClick={() => { setSearching(false); setQuery('') }}
              className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              <IconClose className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 下拉刷新指示：长在列表正上方，只把下半区顶开，新建按钮不受影响 */}
      <div
        className="flex shrink-0 items-center justify-center overflow-hidden"
        style={{
          height: refreshing ? 30 : Math.min(pull, PULL_MAX),
          // 松手/开始刷新时才补一段回弹动画；手指还在拖的时候必须跟手，不能有过渡
          transition: dragging ? 'none' : 'height 300ms cubic-bezier(0.22,1,0.36,1)',
        }}
      >
        {refreshing ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <IconLoader className="size-3.5 animate-spin" />正在刷新
          </span>
        ) : pull > 6 ? (
          <span
            className="flex items-center gap-1.5 text-[11px]"
            style={{
              // 越拉越清晰：到阈值时刚好完全不透明，是个连续的"快好了"信号
              opacity: Math.min(1, pull / PULL_THRESHOLD),
              color: ready ? 'var(--color-accent)' : 'var(--color-ink-400)',
            }}
          >
            <svg
              viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              style={{
                // 箭头随下拉转，到阈值翻成朝上 = "可以松手了"
                transform: `rotate(${ready ? 180 : 0}deg)`,
                transition: 'transform 240ms cubic-bezier(0.22,1,0.36,1)',
              }}
            >
              <path d="M12 5v14M6 13l6 6 6-6" />
            </svg>
            {ready ? '松手刷新' : '下拉刷新'}
          </span>
        ) : null}
      </div>

      {/* ── 列表（可滚 + 下拉刷新）───────────────────────────────── */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-6"
        onTouchStart={(e) => {
          if ((scrollRef.current?.scrollTop ?? 0) <= 0 && !refreshing) {
            pullStart.current = e.touches[0]!.clientY
          }
        }}
        onTouchMove={(e) => {
          if (pullStart.current === null) return
          const d = e.touches[0]!.clientY - pullStart.current
          setPull(d > 0 ? d * 0.4 : 0)
        }}
        onTouchEnd={() => {
          const go = pull >= PULL_THRESHOLD
          pullStart.current = null
          if (go) void doRefresh()
          else setPull(0)
        }}
      >
        {grouped.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-ink-400">
            {query.trim() ? `没有匹配「${query.trim()}」的项目` : '还没有项目，点上面新建一个。'}
          </p>
        ) : (
          <ul className="space-y-3">
            {grouped.map((g, i) => (
              <li key={g.main.id}>
                {g.episodes.length === 0 ? (
                  // 没有续集的项目就是原来那一行，一个字都不变
                  <Row
                    p={g.main} i={i} showCover={showCover}
                    film={filmProgress[g.main.id]} onOpen={onOpen}
                    onDelete={() => void remove(g.main.id)}
                  />
                ) : (
                  /*
                   * 有续集 → 母文件夹。组头写项目名和集数，下面挂两集。
                   * 【组头本身不可点】：点它该打开哪一集？没有答案的按钮
                   * 比没有按钮更糟。要打开就点具体那一集。
                   */
                  <div className="overflow-hidden rounded-2xl border border-line bg-ink-900">
                    <div className="flex items-center gap-2 px-3.5 pb-1 pt-2.5">
                      <IconFolder className="size-3.5 shrink-0 text-ink-400" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink-100">
                        {g.main.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-500">
                        {g.episodes.length + 1} 集
                      </span>
                    </div>
                    <div className="space-y-1.5 p-1.5">
                      {[g.main, ...g.episodes].map((ep, j) => (
                        <Row
                          key={ep.id} p={ep} i={j} showCover={showCover} inGroup
                          film={filmProgress[ep.id]} onOpen={onOpen}
                          onDelete={() => void remove(ep.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * 列表里的一行。主片、续集、没有续集的独立项目共用它——三者在这一行上
 * 要显示的东西完全一样，分开写只会让"改一处忘一处"。
 */
function Row ({ p, i, showCover, film, onOpen, onDelete, inGroup }: {
  p: Project
  i: number
  showCover: boolean
  film?: { composing: boolean; progress: number; state: string }
  onOpen: (id: string) => void
  onDelete: () => void
  inGroup?: boolean
}) {
  const st = STATUS_STYLE[statusOf(p, film)]
  return (
    /* 行本身是可点的 div（不用 <button>）——里头还要放菜单按钮，
       button 套 button 是非法结构 */
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(p.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id) } }}
      className={`group flex w-full cursor-pointer items-center gap-3.5 text-left transition-colors ${
        inGroup
          ? 'rounded-xl bg-ink-850/60 p-2 hover:bg-ink-850'
          : 'rounded-2xl border border-line bg-ink-900 p-3 hover:border-ink-600'
      }`}
    >
      {/*
       * 缩略图。开着封面预览时放【这条片子真正的封面】——列表上看到的
       * 就是它发出去以后别人看到的第一眼。
       *
       * 封面是 9:16，槽位是 52×72（更方）。按【宽度铺满 + 纵向居中裁切】：
       * 宽度顶满不裁、不变形，上下各裁掉一点。反过来按高度铺满的话左右会
       * 被切掉，而标题正在中间，切掉的就是字。
       */}
      <span
        className="relative h-[72px] w-[52px] shrink-0 overflow-hidden rounded-xl"
        style={{
          background: i % 2 === 0
            ? 'linear-gradient(180deg,#122a52,#0f2338)'
            : 'linear-gradient(180deg,#3a2340,#1a1226)',
        }}
      >
        {showCover ? (
          <img
            // v= 跟着标题走：改了标题 URL 就变，缓存自然失效
            src={`/api/projects/${p.id}/cover.jpg?v=${encodeURIComponent(p.coverTitle || p.name)}`}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full object-cover object-center"
          />
        ) : (
          <span
            className="absolute bottom-2 left-1/2 h-9 w-5 -translate-x-1/2 rounded-lg"
            style={{
              background: i % 2 === 0
                ? 'linear-gradient(180deg,#ff7a59,#c0392b)'
                : 'linear-gradient(180deg,#e0a82e,#a06a12)',
            }}
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {/* 组里的行前面挂一个集数徽标，一眼能看出这是第几集 */}
          {inGroup && (
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-bold text-ink-300">
              第 {p.episodeIndex} 集
            </span>
          )}
          <span className="min-w-0 truncate text-base font-bold text-ink-50">{p.name}</span>
        </span>
        <span className="mt-1 block truncate text-xs text-ink-400">
          {film?.composing
            ? <span className="inline-flex items-center gap-1 text-[#e0a82e]"><IconLoader className="size-3 animate-spin" />视频合成中 {film.progress}%</span>
            : p.ttsState === 'generating'
              ? <span className="inline-flex items-center gap-1 text-[#e0a82e]"><IconLoader className="size-3 animate-spin" />配音生成中…</span>
              : summaryOf(p)}
        </span>
      </span>

      <span className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold ${st.cls}`}>
        {st.label}
      </span>

      <RowMenu name={p.name} onDelete={onDelete} />
    </div>
  )
}

/**
 * 每行右侧的「⋮」菜单。删除收进这里，不再是那个手机上根本点不着的隐形按钮。
 * 以后加「收藏 / 置顶」直接往菜单里塞一项即可。
 */
function RowMenu ({ name, onDelete }: { name: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button" aria-label="更多" onClick={() => setOpen((v) => !v)}
        className="flex size-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
      >
        <IconMore className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-32 overflow-hidden rounded-xl border border-line bg-ink-850 py-1 shadow-2xl shadow-black/60">
          <button
            type="button"
            onClick={() => { setOpen(false); if (confirm(`删除「${name}」？`)) onDelete() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-300 transition-colors hover:bg-ink-800 hover:text-danger"
          >
            <IconTrash className="size-4" />删除
          </button>
          {/* 以后：收藏 / 置顶 往这儿加 */}
        </div>
      )}
    </div>
  )
}
