import { usePipeline } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconDownload } from './ui/Icon'

export function ExportPanel () {
  const project = useProjects((s) => s.current())
  const { job, startExport, assets } = usePipeline()
  if (!project) return null

  const hasVideo = assets.some((a) => a.kind === 'video')
  const voiceReady = project.ttsState === 'ready'
  const canExport = hasVideo && voiceReady
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
          disabled={!canExport || running}
          onClick={() => startExport(project.id)}
        >
          {running ? '导出中…' : '导出视频'}
        </Button>
      )}

      {!canExport && !running && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
          {!hasVideo && '需要先上传背景视频。'}
          {hasVideo && !voiceReady && '需要先生成配音。'}
        </div>
      )}
    </div>
  )
}
