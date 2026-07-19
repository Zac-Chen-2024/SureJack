import { usePipeline, filmButton } from '../store/pipeline'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { IconDownload } from './ui/Icon'

/**
 * 「下载视频」。
 *
 * ⚠️【这里没有"导出"这个动作了】。成片在配音就绪时就由后台自动合成
 * （src/compose/film.ts），用户要做的只剩下载。所以主按钮永远是下载——
 * 叫"导出"就等于告诉他还有一步要点，而那一步已经不存在了。
 *
 * 手动重合还留着，但是个**次要入口**（下面那行小字），不是主按钮：
 * 它一年用不上两次，占着主位置只会让人以为那才是正常流程。
 */
export function ExportPanel () {
  const project = useProjects((s) => s.current())
  const film = usePipeline((s) => s.film)
  const recomposeFilm = usePipeline((s) => s.recomposeFilm)

  if (!project) return null

  const voiceReady = project.ttsState === 'ready'
  const btn = filmButton(film, voiceReady)
  const building = film?.state === 'building'

  return (
    <div>
      {building && (
        <div className="mb-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-2">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs text-ink-100">后台合成中</span>
            <span className="text-xs tabular-nums text-ink-400">{film.progress}%</span>
          </div>
          {/* 进度条：唯一用强调色填充的地方，进度本身就是最该被看见的状态 */}
          <div className="h-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${film.progress}%` }}
            />
          </div>
        </div>
      )}

      {btn.action === 'download' ? (
        <a
          href={`/api/projects/${project.id}/film/download`}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-accent-dim"
        >
          <IconDownload className="size-4" />{btn.label}
        </a>
      ) : (
        <Button
          variant="primary" className="w-full"
          disabled={!btn.enabled}
          onClick={() => { if (btn.action === 'retry') void recomposeFilm(project.id) }}
        >
          {btn.label}
        </Button>
      )}

      {btn.hint !== null && (
        <div className={`mt-1.5 text-[11px] leading-relaxed ${
          film?.state === 'error' ? 'text-danger' : 'text-ink-400'
        }`}
        >
          {btn.hint}
        </div>
      )}

      {/*
        * 手动重合：只在【已经有成片】时出现。还在合的时候给这个入口，
        * 用户点一下就是白排一条渲染顶掉正在跑的那条；失败时主按钮
        * 本身已经是"重新合成"了，再来一个是重复。
        */}
      {btn.action === 'download' && (
        <button
          type="button"
          className="mt-1.5 w-full text-[11px] text-ink-400 underline underline-offset-2 transition-colors hover:text-ink-100"
          onClick={() => void recomposeFilm(project.id)}
        >
          重新合成一遍
        </button>
      )}
    </div>
  )
}
