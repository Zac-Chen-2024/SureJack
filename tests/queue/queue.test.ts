import { describe, it, expect } from 'vitest'
import { ExportQueue } from '../../src/queue/queue.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('ExportQueue —— 串行执行', () => {
  it('任务按入队顺序串行跑，不并发', async () => {
    const q = new ExportQueue()
    const order: string[] = []
    let running = 0
    let maxConcurrent = 0

    const make = (id: string) => async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running)
      order.push(id)
      await tick(30)
      running--
      return `/out/${id}.mp4`
    }

    q.enqueue('a', make('a'))
    q.enqueue('b', make('b'))
    q.enqueue('c', make('c'))
    await tick(200)

    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxConcurrent).toBe(1)     // 串行的证据
  })

  it('进度回调被转成事件推给监听者', async () => {
    const q = new ExportQueue()
    const seen: number[] = []
    q.on('j1', (e) => { if (e.status === 'running') seen.push(e.progress) })
    q.enqueue('j1', async (onProgress) => {
      onProgress(25); onProgress(50); onProgress(100)
      return '/out.mp4'
    })
    await tick(80)
    expect(seen).toContain(25)
    expect(seen).toContain(50)
  })

  it('完成时事件带 outputPath 和 status=done', async () => {
    const q = new ExportQueue()
    let final: unknown = null
    q.on('j2', (e) => { if (e.status === 'done') final = e })
    q.enqueue('j2', async () => '/out/j2.mp4')
    await tick(80)
    expect(final).toMatchObject({ status: 'done', progress: 100, outputPath: '/out/j2.mp4' })
  })

  it('失败时事件带 error，且不影响后续任务', async () => {
    const q = new ExportQueue()
    let failed: unknown = null
    let laterRan = false
    q.on('bad', (e) => { if (e.status === 'error') failed = e })
    q.enqueue('bad', async () => { throw new Error('ffmpeg 挂了') })
    q.enqueue('good', async () => { laterRan = true; return '/ok.mp4' })
    await tick(120)
    expect(failed).toMatchObject({ status: 'error' })
    expect((failed as { error: string }).error).toContain('ffmpeg')
    expect(laterRan).toBe(true)      // 一个失败不能拖垮队列
  })

  it('snapshot 让后加入的监听者能立刻拿到当前状态', async () => {
    const q = new ExportQueue()
    q.enqueue('j3', async (onProgress) => { onProgress(40); await tick(60); return '/o.mp4' })
    await tick(20)
    const snap = q.snapshot('j3')
    expect(snap?.status).toBe('running')
    expect(snap?.progress).toBe(40)
  })

  it('取消订阅后不再收到事件', async () => {
    const q = new ExportQueue()
    let count = 0
    const off = q.on('j4', () => { count++ })
    off()
    q.enqueue('j4', async () => '/o.mp4')
    await tick(60)
    expect(count).toBe(0)
  })
})
