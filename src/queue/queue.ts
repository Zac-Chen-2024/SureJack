export type JobStatusEvent = 'queued' | 'running' | 'done' | 'error'

export interface QueueEvent {
  jobId: string
  status: JobStatusEvent
  progress: number
  error?: string
  outputPath?: string
}

type Listener = (e: QueueEvent) => void
type Runner = (onProgress: (pct: number) => void) => Promise<string>

/**
 * 进程内串行导出队列。
 *
 * 为什么串行：ffmpeg 是 CPU 密集的，两个用户的场景下并发渲染只会互相拖慢，
 * 还可能吃满内存。串行简单、可预测（设计文档第 12 节：两个用户上分布式队列纯属自残）。
 *
 * 为什么带 snapshot：SSE 连接可能在任务跑到一半时才建立，
 * 新订阅者必须能立刻拿到当前进度，而不是干等下一次 tick。
 */
export class ExportQueue {
  private pending: Array<{ jobId: string; run: Runner }> = []
  private busy = false
  private listeners = new Map<string, Set<Listener>>()
  private state = new Map<string, QueueEvent>()

  enqueue (jobId: string, run: Runner): void {
    this.setState({ jobId, status: 'queued', progress: 0 })
    this.pending.push({ jobId, run })
    void this.drain()
  }

  on (jobId: string, listener: Listener): () => void {
    if (!this.listeners.has(jobId)) this.listeners.set(jobId, new Set())
    this.listeners.get(jobId)!.add(listener)
    return () => { this.listeners.get(jobId)?.delete(listener) }
  }

  snapshot (jobId: string): QueueEvent | null {
    return this.state.get(jobId) ?? null
  }

  private setState (e: QueueEvent): void {
    this.state.set(e.jobId, e)
    for (const l of this.listeners.get(e.jobId) ?? []) {
      try { l(e) } catch { /* 一个监听者出错不能影响队列 */ }
    }
  }

  private async drain (): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift()!
        this.setState({ jobId: item.jobId, status: 'running', progress: 0 })
        try {
          const outputPath = await item.run((pct) => {
            this.setState({ jobId: item.jobId, status: 'running', progress: Math.round(pct) })
          })
          this.setState({ jobId: item.jobId, status: 'done', progress: 100, outputPath })
        } catch (e) {
          // 一个任务失败绝不能拖垮整个队列——后面的还要跑
          this.setState({
            jobId: item.jobId, status: 'error', progress: 0,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    } finally {
      this.busy = false
    }
  }
}
