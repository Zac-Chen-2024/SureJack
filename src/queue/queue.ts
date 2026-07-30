export type JobStatusEvent = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueEvent {
  jobId: string
  status: JobStatusEvent
  progress: number
  error?: string
  outputPath?: string
}

type Listener = (e: QueueEvent) => void
type Runner = (onProgress: (pct: number) => void, signal: AbortSignal) => Promise<string>

/**
 * 进程内串行导出队列。
 *
 * 为什么串行：ffmpeg 是 CPU 密集的，两个用户的场景下并发渲染只会互相拖慢，
 * 还可能吃满内存。串行简单、可预测（设计文档第 12 节：两个用户上分布式队列纯属自残）。
 *
 * 为什么带 snapshot：SSE 连接可能在任务跑到一半时才建立，
 * 新订阅者必须能立刻拿到当前进度，而不是干等下一次 tick。
 */
/**
 * 任务分道。
 *
 * heavy = 烧录母带：CPU 密集，十几分钟，必须串行（四核机器上并发只会互相拖慢）。
 * light = 混背景音乐：视频流 -c:v copy、只重编码音频，实测 9 秒。
 *
 * 【为什么必须分开】：混音挂在同一条串行队列上时，一个 9 秒的活会排在
 * 十几分钟的烧录后面——用户换首 BGM 点下载，要干等一条和他无关的烧录跑完。
 * 而混音几乎不吃 CPU，和烧录并行完全没问题。
 */
export type JobLane = 'heavy' | 'light'

export class ExportQueue {
  private pending: Record<JobLane, Array<{ jobId: string; run: Runner }>> = { heavy: [], light: [] }
  private busy: Record<JobLane, boolean> = { heavy: false, light: false }
  private listeners = new Map<string, Set<Listener>>()
  private state = new Map<string, QueueEvent>()
  /** 各道正在跑的任务的中断器。用户点「中断」时 abort 它，ffmpeg 会被杀掉 */
  private running: Array<{ jobId: string; ctrl: AbortController }> = []

  enqueue (jobId: string, run: Runner, lane: JobLane = 'heavy'): void {
    this.setState({ jobId, status: 'queued', progress: 0 })
    this.pending[lane].push({ jobId, run })
    void this.drain(lane)
  }

  on (jobId: string, listener: Listener): () => void {
    if (!this.listeners.has(jobId)) this.listeners.set(jobId, new Set())
    this.listeners.get(jobId)!.add(listener)
    return () => { this.listeners.get(jobId)?.delete(listener) }
  }

  snapshot (jobId: string): QueueEvent | null {
    return this.state.get(jobId) ?? null
  }

  /**
   * 中断一个任务。
   *
   * 还在排队 → 直接从队列里摘掉；正在跑 → abort 它的 signal，
   * ffmpeg 收到 SIGKILL 结束（见 render/ffmpeg.ts）。
   * 返回是否真的中断了什么——没有的话调用方可以回一句"它已经结束了"。
   *
   * 合成一条片子要十几分钟，跑错了必须能立刻叫停：既省 CPU（四核机器上
   * 一条烧录会拖慢一切），也让用户不必干等一条自己已经不要的片子。
   */
  cancel (jobId: string): boolean {
    for (const lane of ['heavy', 'light'] as JobLane[]) {
      const before = this.pending[lane].length
      this.pending[lane] = this.pending[lane].filter((p) => p.jobId !== jobId)
      if (this.pending[lane].length !== before) {
        this.setState({ jobId, status: 'cancelled', progress: 0 })
        return true
      }
    }
    const hit = this.running.find((r) => r.jobId === jobId)
    if (hit) { hit.ctrl.abort(); return true }
    return false
  }

  private setState (e: QueueEvent): void {
    this.state.set(e.jobId, e)
    for (const l of this.listeners.get(e.jobId) ?? []) {
      try { l(e) } catch { /* 一个监听者出错不能影响队列 */ }
    }
  }

  private async drain (lane: JobLane): Promise<void> {
    if (this.busy[lane]) return
    this.busy[lane] = true
    try {
      while (this.pending[lane].length > 0) {
        const item = this.pending[lane].shift()!
        const ctrl = new AbortController()
        const entry = { jobId: item.jobId, ctrl }
        this.running.push(entry)
        this.setState({ jobId: item.jobId, status: 'running', progress: 0 })
        try {
          const outputPath = await item.run((pct) => {
            this.setState({ jobId: item.jobId, status: 'running', progress: Math.round(pct) })
          }, ctrl.signal)
          this.setState({ jobId: item.jobId, status: 'done', progress: 100, outputPath })
        } catch (e) {
          // 被用户中断和真失败要分开：中断不是错误，别在界面上报红
          if (ctrl.signal.aborted) {
            this.setState({ jobId: item.jobId, status: 'cancelled', progress: 0 })
          } else {
            // 一个任务失败绝不能拖垮整个队列——后面的还要跑
            this.setState({
              jobId: item.jobId, status: 'error', progress: 0,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        } finally {
          this.running = this.running.filter((r) => r !== entry)
        }
      }
    } finally {
      this.busy[lane] = false
    }
  }
}
