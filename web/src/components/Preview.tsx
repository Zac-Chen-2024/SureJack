import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { IconPlay } from './ui/Icon'

/**
 * 9:16 实时预览（右列上半）。
 *
 * TODO(Task 3)：目前只画出正确比例的空框，没有任何播放能力。
 * 完整实现见 docs/superpowers/plans/2026-07-19-workspace-relayout.md 的 Task 3：
 *   - JASSUB(libass-wasm) 渲染 GET /api/projects/:id/subtitles.ass，与导出烧录同源
 *   - 单一时间源：配音 <audio> 驱动，背景视频静音循环跟随，切忌两个媒体元素各走各的钟
 *   - 字体必须显式传 Noto Sans CJK SC；wasm 的 MIME 必须是 application/wasm
 *   - 项目切换 / 卸载时 destroy() JASSUB 实例，否则 worker 泄漏
 */
export function Preview () {
  const project = useProjects((s) => s.current())
  const hasVideo = usePipeline((s) => s.assets.some((a) => a.kind === 'video'))
  const voiceReady = project?.ttsState === 'ready'

  const hint = !hasVideo
    ? '上传背景视频后，这里显示 9:16 的成片预览。'
    : !voiceReady
      ? '生成配音后，这里会带着字幕逐字播放。'
      : '预览即将在这里播放。'

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-4"
      style={{ containerType: 'size' }}
    >
      {/*
        9:16 空框，按 contain 的方式塞进这一栏：宽高两个方向哪个先顶住就以哪个为准。
        竖屏画幅在高度上比宽度吃紧得多——400 宽就要 711 高，1080p 屏幕上放不下，
        所以高度经常才是真正的约束。

        为什么不用「width:100% + max-height:100%」那种写法：试过，是错的。
        max-height 会把高度剪短，但宽度仍然停在 100%，aspect-ratio 直接失效——
        1280x800 下实测长宽比变成 0.63，画幅比真正的 9:16 胖了一圈，
        预览就不再是所见即所得了。

        正确做法是先把高度算成两个方向的较小值（容器查询单位 cqh/cqw 拿到的是
        这一栏内容盒的尺寸），高度定死之后再由 aspect-ratio 反推宽度。
        外层是 flex 容器，所以这里的 width:auto 会走内容尺寸、被 aspect-ratio 接管，
        不会像普通块级元素那样摊平成 100%。
      */}
      <div
        className="flex flex-none items-center justify-center rounded-xl border border-dashed border-line-strong bg-ink-950"
        style={{ height: 'min(100cqh, 100cqw * 16 / 9)', aspectRatio: '9 / 16' }}
      >
        <div className="flex flex-col items-center gap-2.5 px-6 text-center">
          <IconPlay className="size-7 text-ink-600" />
          <p className="max-w-[24ch] text-xs leading-relaxed text-ink-400">{hint}</p>
        </div>
      </div>
    </div>
  )
}
