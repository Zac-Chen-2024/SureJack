import { useRef, useState } from 'react'
import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { useSubtitles } from '../store/subtitles'
import { Button } from './ui/Button'
import { IconMic, IconCheck, IconLoader, IconUpload } from './ui/Icon'

const STATE_TEXT: Record<string, string> = {
  none: '还没生成', generating: '生成中…', ready: '已就绪',
  stale: '文案改过了，需要重新生成', error: '生成失败',
}

/**
 * 配音。**它是字幕栏的头部，不是一块独立的面板。**
 *
 * 字幕完全由配音的时间戳推导——它俩本来就是一件事。把生成按钮放在字幕
 * 列表正上方，用户不用在两栏之间来回看就知道「字幕为什么是空的」：
 * 原因和结果在同一个视野里。
 *
 * 这里有【两条路】通向同一个终点：
 *   1. 生成配音：文案 → Azure → **词级**时间戳 → 逐字扫光字幕
 *   2. 自备配音 + SRT：拖进来直接用 → **句级**时间戳 → 整句字幕
 * 两条路都只往项目的 wordTimingsJson + ttsDurationMs 里写，下游的预览、
 * 背景排布、导出不区分来源。
 *
 * ⚠️ **整个配音区都是拖放目标**，不是里面某个小方块——让用户瞄准一个
 * 40px 高的虚线框，拖偏一点就丢到框外，而框外的默认行为是浏览器直接
 * 打开那个 mp3，当前页面连同没保存的文案一起没了。同理 `onDragOver`
 * 【必须】`preventDefault()`：不拦就等于没做拖放。
 */
export function VoicePanel () {
  const project = useProjects((s) => s.current())
  const reload = useProjects((s) => s.load)
  const loadSubtitles = useSubtitles((s) => s.load)
  const {
    generateVoice, adoptFiles, voiceBusy, voiceSegmentCount,
    byoBusy, byoHint, byoWarning, byoScriptFilled,
  } = usePipeline()
  const [dragging, setDragging] = useState(false)
  /*
   * dragenter/dragleave 在子元素边界上会成对乱飞（进按钮 = 离开父容器的
   * 一次 leave + 一次 enter），直接用布尔量会让高亮疯狂闪烁。用深度计数
   * 抵消，归零才算真的离开。
   */
  const dragDepth = useRef(0)

  if (!project) return null
  const current = project

  const state = current.ttsState ?? 'none'
  const seconds = current.ttsDurationMs ? Math.round(current.ttsDurationMs / 1000) : null
  const isByo = current.subtitleMode === 'line'

  async function handleFiles (files: File[]) {
    if (files.length === 0) return
    const ok = await adoptFiles(current.id, files)
    // 派生成功后字幕列表要【立刻】有内容，文案区也要看到回填的正文
    if (ok) {
      await reload()
      await loadSubtitles(current.id)
    }
  }

  return (
    <div
      // 拦掉 dragover 的默认行为，否则松手时浏览器直接打开文件、页面丢失
      onDragOver={(e) => { e.preventDefault() }}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragging(true) }}
      onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false) }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void handleFiles(Array.from(e.dataTransfer.files))
      }}
      data-testid="voice-panel"
      className={`shrink-0 border-b px-3 py-2 transition-colors ${
        dragging ? 'border-accent bg-accent/10 ring-1 ring-inset ring-accent/40' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
          <IconMic className="size-3.5" />配音
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          {byoBusy && <IconLoader className="size-3.5 shrink-0 animate-spin text-ink-400" />}
          {!byoBusy && state === 'ready' && <IconCheck className="size-3.5 shrink-0 text-accent" />}
          {!byoBusy && state === 'generating' && <IconLoader className="size-3.5 shrink-0 animate-spin text-ink-400" />}
          <span className={`truncate ${state === 'stale' ? 'text-accent' : 'text-ink-100'}`}>
            {byoBusy ? '正在导入…' : state === 'ready' && isByo ? '已就绪（自备配音）' : STATE_TEXT[state]}
          </span>
          {seconds !== null && state === 'ready' && (
            <span className="shrink-0 tabular-nums text-[11px] text-ink-400">
              {Math.floor(seconds / 60)} 分 {seconds % 60} 秒
            </span>
          )}
        </span>

        <Button
          variant={state === 'ready' ? 'ghost' : 'primary'}
          className="shrink-0"
          disabled={voiceBusy || byoBusy || !current.scriptText.trim()}
          onClick={async () => { await generateVoice(current.id); await reload() }}
        >
          {voiceBusy ? '生成中…' : state === 'none' ? '生成配音' : '重新生成'}
        </Button>
      </div>

      {/*
        自备这条路的说明【必须留在界面上】，不能只写在文档里：用户传完
        SRT 发现字幕不扫光，没人告诉他这是格式决定的，他就会以为坏了、
        反复重传。
      */}
      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-400">
        <IconUpload className="mt-0.5 size-3 shrink-0" />
        <span>
          已经配好音了？把配音和字幕（mp3 / wav / m4a / aac 加 .srt）一起拖到这块区域，跳过生成。
          <span className="text-ink-300">自备字幕是整句显示，没有逐字高亮</span>
          ——SRT 只记整句的起止时间，格式本身就没有逐字信息。
        </span>
      </p>

      {byoHint !== null && (
        <p className="mt-1 text-[11px] leading-relaxed text-accent">{byoHint}</p>
      )}

      {byoWarning !== null && (
        <p className="mt-1 text-[11px] leading-relaxed text-accent">{byoWarning}</p>
      )}

      {byoScriptFilled === true && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          已把字幕正文填回文案区，可以直接编辑。
          <span className="text-ink-300">但改文案不会改字幕</span>
          ——这条路的字幕来自你传的 SRT，不是从文案推出来的（和生成配音正好相反）。
        </p>
      )}

      {byoScriptFilled === false && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          文案区已有内容，没有覆盖。字幕用的是你传的 SRT，改文案不会改字幕。
        </p>
      )}

      {voiceSegmentCount !== null && voiceSegmentCount > 1 && state === 'ready' && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          文案较长，已分 {voiceSegmentCount} 段合成并自动拼接。段落衔接处语气可能略有变化。
        </p>
      )}
    </div>
  )
}
