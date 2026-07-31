import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../../store/projects'
import { usePipeline } from '../../store/pipeline'
import { useRename, renameGates } from '../../store/rename'
import { NameReplacePanel } from '../NameReplacePanel'
import { IconChevronLeft, IconUpload, IconLoader, IconEdit, IconScissors} from '../ui/Icon'
import { SplitPicker } from './SplitPicker'
import { EpisodeTitles } from './EpisodeTitles'

/**
 * 新建项目引导页（点「新建项目」进来）。一条线走完：
 *   项目名 + 粘贴/上传文案 → 分析人名并继续（建项目+调 API）→ 同页展开
 *   可编辑替换表（NameReplacePanel）→ 确认无误 → 生成配音并合成 → 进编辑器。
 *
 * 建项目发生在点「分析人名并继续」那一刻（带上已填的名字和文案），不提前
 * 造空项目。之后所有操作都作用在这个已建项目上，复用现有 per-project 机制。
 */
export function MobileNewProject ({ onBack, onGo, resumeId }: {
  onBack: () => void
  onGo: (id: string) => void
  /**
   * 【接着上次继续】。已经建了项目、文案也贴了，但还没走完分析/生成就退出去了
   * ——再点进来该回到这一页接着填，而不是甩给他一屏"还没有成片"。
   * 那屏说的是实话，但它答的不是用户此刻的问题：他要的是"接着弄完"。
   */
  resumeId?: string
}) {
  const { create, updateScript } = useProjects()
  const project = useProjects((s) => s.current())
  const analyze = useRename((s) => s.analyze)
  const renameError = useRename((s) => s.error)
  const generateVoice = usePipeline((s) => s.generateVoice)

  const resumed = useProjects((s) => (resumeId ? s.items.find((p) => p.id === resumeId) : undefined))
  const [name, setName] = useState(resumed?.name ?? '')
  const [script, setScript] = useState(resumed?.scriptText ?? '')
  const [createdId, setCreatedId] = useState<string | null>(resumeId ?? null)
  const [busy, setBusy] = useState<'analyze' | 'generate' | null>(null)
  /*
   * 【自动创建续集】。开着的话，确认人名之后先进断点选择，拆完再生成——
   * 顺序不能反：拆分会改主片正文，配音必须在最终文本定下来之后才开始，
   * 否则主片的配音里还念着已经被砍掉的结局。
   */
  const [autoSequel, setAutoSequel] = useState(false)
  const [splitting, setSplitting] = useState(false)
  /** 拆出来的续集。有它就说明这一批要生成两条片子 */
  const [sequelId, setSequelId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /*
   * 接着上次继续时，把选中项目切过去——下面的 NameReplacePanel 之类都读
   * store 里的"当前项目"，不切的话它们看的还是别的项目。
   */
  useEffect(() => {
    if (resumeId && useProjects.getState().currentId !== resumeId) {
      useProjects.getState().select(resumeId)
    }
  }, [resumeId])

  // 列表异步加载完才拿得到这条项目，到了再把名字和文案补上（只补一次）
  const filled = useRef(false)
  useEffect(() => {
    if (!resumed || filled.current) return
    filled.current = true
    setName(resumed.name)
    setScript(resumed.scriptText ?? '')
  }, [resumed])

  /**
   * 建项目并把【页面上这份原始文案】写进去。只在"分析"那一步调。
   *
   * ⚠️【绝不能在"生成"时再调一次】。踩过：原来 onGenerate 也走 ensureProject，
   * 而它里面 updateScript(script) 会用页面上那份【原始粘贴文本】把后端刚写好的
   * "已去章节/数字行 + 已改名"的文案覆盖回去 → 配音和字幕全是拿原文做的：
   * 数字行还在、人名也没换。表现就是"周周撸铁"那条片子字幕里还念着 1 2 3。
   */
  async function ensureProject (): Promise<string> {
    if (createdId) return createdId
    await create(name.trim() || '未命名项目')
    const id = useProjects.getState().currentId!
    await updateScript(script)
    setCreatedId(id)
    return id
  }

  async function onAnalyze () {
    setBusy('analyze')
    try { const id = await ensureProject(); await analyze(id) } finally { setBusy(null) }
  }
  async function onGenerate () {
    setBusy('generate')
    try {
      // 不再碰 scriptText——此刻库里那份是"确认替换"后的成品，动它就等于回退
      const id = createdId ?? await ensureProject()
      /*
       * 【不等配音跑完】：立刻开跑 + 立刻进编辑器看进度蒙层（配音中→合成中）。
       * 配音/合成都在后台，这期间能返回列表继续建别的项目。
       *
       * 【续集不在这里发第二次请求】：主片配完之后服务端会自己接着配续集
       * （见 tts/routes.ts）。放前端的话要求页面一直开着，而按下生成就
       * 切走/锁屏是常态——页面一走，续集就永远停在草稿。
       */
      void generateVoice(id)
      onGo(id)
    } finally { setBusy(null) }
  }

  function pickFile (f: File | undefined) {
    if (!f) return
    void f.text().then((t) => setScript(t))
  }

  const canAnalyze = script.trim().length > 0 && busy === null
  // 建好后：改名没确认（且开着）就不让生成——和配音入口同一道门
  const gated = createdId !== null && renameGates(project)
  const canGenerate = script.trim().length > 0 && !gated && busy === null

  return (
    <div className="absolute inset-0 overflow-y-auto bg-ink-950" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button type="button" onClick={onBack} aria-label="返回" className="flex size-9 items-center justify-center rounded-full border border-line bg-ink-900 text-ink-100">
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
        </button>
        <h2 className="text-lg font-extrabold text-ink-50">{resumeId ? '接着完成' : '新建项目'}</h2>
      </div>

      <div className="space-y-4 px-4 pb-10">
        {/* 项目名 */}
        <div>
          <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-ink-400">项目名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="给这条视频起个名"
            disabled={createdId !== null}
            className="w-full rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-[15px] text-ink-50 outline-none placeholder:text-ink-400 focus:border-accent disabled:opacity-60"
          />
        </div>

        {/* 自动创建续集：新建时就要定，因为它决定确认之后走哪条路 */}
        <label className="flex items-start gap-2.5 rounded-xl border border-line bg-ink-900 p-3">
          <input
            type="checkbox"
            checked={autoSequel}
            onChange={(e) => setAutoSequel(e.target.checked)}
            disabled={createdId !== null && splitting}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-bold text-ink-50">自动创建续集</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-400">
              把这条长文拆成主片和续集两条视频。主片在悬念处收尾，续集从「引子 +
              周周提醒你…」开始接着讲。断点由 AI 推荐，你可以滚轮微调。
            </span>
          </span>
        </label>

        {/* 文案：粘贴 + 上传 txt */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[11px] font-medium uppercase tracking-wider text-ink-400">文案</label>
            <button type="button" onClick={() => fileInput.current?.click()} className="flex items-center gap-1 text-xs text-ink-300 hover:text-accent">
              <IconUpload className="size-3.5" />上传 txt
            </button>
            <input ref={fileInput} type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="把小说/文案粘贴到这里，或上传 txt 文件"
            className="h-40 w-full resize-none rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-sm leading-relaxed text-ink-50 outline-none placeholder:text-ink-400 focus:border-accent"
          />
          <p className="mt-1 text-[11px] tabular-nums text-ink-600">{[...script].length} 字</p>
        </div>

        {/* 分析人名并继续（建项目 + 调 API）——建好后这个按钮变成"重新分析"由下面面板接管 */}
        {createdId === null ? (
          <button
            type="button" onClick={() => void onAnalyze()} disabled={!canAnalyze}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-sm font-extrabold text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-40"
          >
            {busy === 'analyze' ? <><IconLoader className="size-4 animate-spin" />分析中…</> : <><IconEdit className="size-4" />分析人名并继续</>}
          </button>
        ) : null}

        {/* 分析失败要在【这一页】就说清楚并能重试——之前失败了这页什么都不显示，
            用户只看到按钮弹回去，完全不知道发生了什么 */}
        {renameError && (
          <div className="rounded-xl border border-danger/40 bg-danger/10 p-3">
            <p className="text-xs leading-relaxed text-danger">{renameError}</p>
            <button
              type="button" onClick={() => void onAnalyze()} disabled={busy !== null}
              className="mt-2 rounded-lg border border-danger/50 px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
            >
              重试分析
            </button>
          </div>
        )}

        {createdId === null ? null : (
          <>
            {/* 已建项目：复用替换面板（开关/重新分析/可编辑表/关系图/确认都在里面） */}
            <NameReplacePanel />

            {/*
              * 开了续集开关：把「生成」换成「选断点」。中间隔着用户的确认，
              * 因为拆下去会改主片正文并新建一个项目，这两件事都不该在他
              * 还没看清楚的时候发生。
              */}
            {autoSequel && !splitting && (
              <button
                type="button" onClick={() => setSplitting(true)} disabled={!canGenerate}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-sm font-extrabold text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-40"
              >
                <IconScissors className="size-4" />选择断点并拆成两集
              </button>
            )}

            {autoSequel && splitting && createdId && (
              <SplitPicker
                projectId={createdId}
                onCancel={() => setSplitting(false)}
                onDone={({ sequelId: sid }) => {
                  setSplitting(false)
                  setSequelId(sid)
                  // 拆完【不立刻生成】：先让用户把两条片子的标题分别定好。
                  // 这两个字段会被烧进产物，生成之后再改代价完全不同。
                  void useProjects.getState().load()
                }}
              />
            )}

            {/*
              * 标题：封面标题和片内标题都会被【烧进产物】，所以正确的位置就是
              * "按下生成之前的最后一屏"。拆过集的话两条片子分别填。
              */}
            {!splitting && <EpisodeTitles ids={sequelId ? [createdId, sequelId] : [createdId]} />}

            {!splitting && (!autoSequel || sequelId) && (
              <button
                type="button" onClick={() => void onGenerate()} disabled={!canGenerate}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-sm font-extrabold text-ink-950 transition-colors hover:bg-accent-dim disabled:opacity-40"
              >
                {busy === 'generate'
                  ? <><IconLoader className="size-4 animate-spin" />提交中…</>
                  : sequelId ? '生成两集的配音并合成' : '生成配音并合成视频'}
              </button>
            )}
            {gated && <p className="text-center text-[11px] text-accent">先在上面确认人名替换（或关掉人名替换），才能生成。</p>}
          </>
        )}
      </div>
    </div>
  )
}
