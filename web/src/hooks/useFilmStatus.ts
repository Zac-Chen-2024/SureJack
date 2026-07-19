import { useEffect } from 'react'
import { usePipeline, shouldPollFilm } from '../store/pipeline'

/**
 * 盯着成片状态。
 *
 * 【为什么是个独立 hook 而不是待在 ExportPanel 里】：成片一好，预览那栏
 * 就整块换成 FilmPlayer，原来挂着轮询的组件跟着卸载——轮询也就断了。
 * 于是用户改完文案（成片作废）之后，界面上再没有任何东西会去问一句
 * "现在怎么样了"，播放器会一直播着那条已经过期的片子。
 *
 * 所以这件事必须挂在【整栏都在的地方】，和谁在渲染无关。
 *
 * 【依赖里带 updatedAt】：换 BGM、调音量、拖字幕高度、改文案——每一样都会
 * 刷新 updatedAt，也都会让成片作废（后端按指纹判，见 film.ts）。带上它，
 * 一改设置这里就重新问一次，后端顺手把重合排上。
 *
 * 【只在 building 时才继续轮询】：终态还接着问，是让用户的机器白跑请求。
 */
export function useFilmStatus (project: {
  id: string
  updatedAt: string
  ttsState: string
  ttsDurationMs: number | null
} | null): void {
  const loadFilm = usePipeline((s) => s.loadFilm)
  const projectId = project?.id ?? null

  useEffect(() => {
    if (projectId === null) return
    let cancelled = false
    void loadFilm(projectId)
    const timer = setInterval(() => {
      if (cancelled) return
      if (!shouldPollFilm(usePipeline.getState().film)) {
        clearInterval(timer)
        return
      }
      void loadFilm(projectId)
    }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [projectId, project?.updatedAt, project?.ttsState, project?.ttsDurationMs, loadFilm])
}
