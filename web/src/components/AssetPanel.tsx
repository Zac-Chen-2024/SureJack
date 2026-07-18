import { useRef } from 'react'
import { usePipeline, type Asset } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { IconUpload, IconFilm, IconMusic, IconTrash } from './ui/Icon'

function fmtSize (bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtDuration (ms: number | null): string {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function AssetRow ({ asset, projectId }: { asset: Asset; projectId: string }) {
  const { removeAsset } = usePipeline()
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-line bg-ink-850 px-2.5 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink-100">{asset.originalName}</span>
        <span className="block text-[11px] tabular-nums text-ink-400">
          {fmtSize(asset.size)}{asset.durationMs ? ` · ${fmtDuration(asset.durationMs)}` : ''}
        </span>
      </span>
      <button
        onClick={() => removeAsset(asset.id, projectId)}
        className="rounded p-1 text-ink-400 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
        title="删除"
      ><IconTrash className="size-3.5" /></button>
    </div>
  )
}

function UploadSlot ({ kind, label, icon, projectId }: {
  kind: 'video' | 'bgm'; label: string; icon: React.ReactNode; projectId: string
}) {
  const { assets, upload, uploading } = usePipeline()
  const inputRef = useRef<HTMLInputElement>(null)
  const mine = assets.filter((a) => a.kind === kind)

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
        {icon}{label}
      </div>
      <div className="space-y-1.5">
        {mine.map((a) => <AssetRow key={a.id} asset={a} projectId={projectId} />)}
      </div>
      <input
        ref={inputRef} type="file" className="hidden"
        accept={kind === 'video' ? 'video/*' : 'audio/*'}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload(projectId, f, kind)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-ink-300 transition-colors hover:border-accent/40 hover:text-ink-100 disabled:opacity-40"
      >
        <IconUpload className="size-3.5" />
        {uploading ? '上传中…' : mine.length > 0 ? '换一个' : '上传'}
      </button>
    </div>
  )
}

export function AssetPanel () {
  const project = useProjects((s) => s.current())
  const { error } = usePipeline()
  if (!project) return null

  return (
    <div className="space-y-4">
      <UploadSlot kind="video" label="背景视频" icon={<IconFilm className="size-3.5" />} projectId={project.id} />
      <UploadSlot kind="bgm" label="背景音乐" icon={<IconMusic className="size-3.5" />} projectId={project.id} />
      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">{error}</div>}
    </div>
  )
}
