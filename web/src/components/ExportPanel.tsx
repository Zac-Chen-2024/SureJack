import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconDownload } from './ui/Icon'

export function ExportPanel () {
  const project = useProjects((s) => s.current())
  const { job, startExport } = usePipeline()
  if (!project) return null

  /*
   * 唯一的前置条件是【配音】。
   *
   * 老代码这里还要求「有上传的背景视频」——那句话现在不成立了：背景由素材库
   * 按三段式公式现拼，本来就不用传。后端的校验顺序也已经改成
   * 多个上传视频 → 配音 → 素材库（src/queue/routes.ts）。
   * 而多个上传视频在这一版界面里根本产生不了（素材栏没有上传），
   * 所以前端只剩配音这一条要挡。
   */
  const voiceReady = project.ttsState === 'ready'
  const running = job?.status === 'queued' || job?.status === 'running'

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-400">导出</div>

      {running && (
        <div className="mb-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-2">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs text-ink-100">
              {job.status === 'queued' ? '排队中' : '合成中'}
            </span>
            <span className="text-xs tabular-nums text-ink-400">{job.progress}%</span>
          </div>
          {/* 进度条：唯一用强调色填充的地方，进度本身就是最该被看见的状态 */}
          <div className="h-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {job?.status === 'error' && (
        <div className="mb-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          {job.error ?? '导出失败'}
        </div>
      )}

      {job?.status === 'done' ? (
        <a
          href={`/api/jobs/${job.jobId}/download`}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconDownload className="size-4" />下载成片
        </a>
      ) : (
        <Button
          variant="primary" className="w-full"
          disabled={!voiceReady || running}
          onClick={() => startExport(project.id)}
        >
          {running ? '导出中…' : '导出视频'}
        </Button>
      )}

      {!voiceReady && !running && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          需要先生成配音——背景的长度由配音决定。
        </div>
      )}
    </div>
  )
}
