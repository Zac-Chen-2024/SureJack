import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { classifyDroppedFiles, missingHint, usePipeline } from '../../web/src/store/pipeline'

function file (name: string): File {
  return new File(['x'], name, { type: '' })
}

describe('classifyDroppedFiles：按扩展名自动分辨谁是配音谁是字幕', () => {
  it('一次拖入音频 + srt，各归各位——不用让用户分别拖', () => {
    const c = classifyDroppedFiles([file('旁白.mp3'), file('字幕.srt')])
    expect(c.voice?.name).toBe('旁白.mp3')
    expect(c.srt?.name).toBe('字幕.srt')
    expect(c.rejected).toEqual([])
  })

  it('顺序无关——先拖 srt 后拖音频也一样', () => {
    const c = classifyDroppedFiles([file('字幕.srt'), file('旁白.wav')])
    expect(c.voice?.name).toBe('旁白.wav')
    expect(c.srt?.name).toBe('字幕.srt')
  })

  it('大小写不敏感', () => {
    const c = classifyDroppedFiles([file('A.MP3'), file('B.SRT')])
    expect(c.voice?.name).toBe('A.MP3')
    expect(c.srt?.name).toBe('B.SRT')
  })

  it('四种音频扩展名都认', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'aac']) {
      expect(classifyDroppedFiles([file(`a.${ext}`)]).voice?.name).toBe(`a.${ext}`)
    }
  })

  it('认不出来的文件进 rejected，不静默丢弃', () => {
    const c = classifyDroppedFiles([file('片子.mp4'), file('稿子.docx')])
    expect(c.voice).toBe(null)
    expect(c.srt).toBe(null)
    expect(c.rejected).toEqual(['片子.mp4', '稿子.docx'])
  })

  it('同种拖了两个只取第一个——各只能有一份，第二个当作被拒并说出来', () => {
    const c = classifyDroppedFiles([file('甲.mp3'), file('乙.mp3')])
    expect(c.voice?.name).toBe('甲.mp3')
    expect(c.rejected).toEqual(['乙.mp3'])
  })

  it('没有扩展名的文件不会被当成 srt', () => {
    const c = classifyDroppedFiles([file('README')])
    expect(c.srt).toBe(null)
    expect(c.rejected).toEqual(['README'])
  })
})

describe('missingHint：只拖了一个时说清还差什么', () => {
  it('只有配音 → 还差字幕', () => {
    expect(missingHint({ hasVoice: true, hasSrt: false })).toBe('已收到配音，还差字幕文件（.srt）')
  })

  it('只有字幕 → 还差配音', () => {
    expect(missingHint({ hasVoice: false, hasSrt: true })).toBe('已收到字幕，还差配音文件（mp3 / wav / m4a / aac）')
  })

  it('两个都齐了没有提示', () => {
    expect(missingHint({ hasVoice: true, hasSrt: true })).toBe(null)
  })

  it('两个都没有也没有提示——还没开始拖，别先报错', () => {
    expect(missingHint({ hasVoice: false, hasSrt: false })).toBe(null)
  })
})

/** 记录 fetch 到的请求，按 url 回不同的假响应 */
function mockFetch (handlers: Record<string, unknown>) {
  const calls: { url: string; method: string }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const key = Object.keys(handlers).find((k) => url.includes(k))
    const body = key === undefined ? {} : handlers[key]
    if (body !== null && typeof body === 'object' && 'status' in body) {
      const b = body as { status: number; error: string }
      return new Response(JSON.stringify({ error: b.error }), { status: b.status })
    }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const ASSET = (kind: string) => ({
  id: kind, projectId: 'p1', kind, path: '/x', originalName: `a.${kind}`,
  size: 1, durationMs: null, createdAt: '2026-07-19T00:00:00.000Z',
})

describe('adoptFiles：拖完自动派生', () => {
  beforeEach(() => { usePipeline.getState().reset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('两个文件都在 → 各传一次，然后调 adopt-srt', async () => {
    const calls = mockFetch({
      '/assets?kind=voice': ASSET('voice'),
      '/assets?kind=srt': ASSET('srt'),
      '/adopt-srt': { cueCount: 12, durationMs: 65_087, subtitleMode: 'line', scriptFilled: true, warning: null },
      '/assets': [ASSET('voice'), ASSET('srt')],
    })

    const ok = await usePipeline.getState().adoptFiles('p1', [file('a.mp3'), file('b.srt')])
    expect(ok).toBe(true)

    const uploads = calls.filter((c) => c.url.includes('kind='))
    expect(uploads.map((c) => c.url)).toEqual([
      '/api/projects/p1/assets?kind=voice',
      '/api/projects/p1/assets?kind=srt',
    ])
    expect(calls.some((c) => c.url.endsWith('/adopt-srt') && c.method === 'POST')).toBe(true)
    expect(usePipeline.getState().error).toBe(null)
    expect(usePipeline.getState().byoBusy).toBe(false)
  })

  it('只拖了配音 → 不调 adopt-srt，只提示还差什么', async () => {
    const calls = mockFetch({
      '/assets?kind=voice': ASSET('voice'),
      '/assets': [ASSET('voice')],
    })

    const ok = await usePipeline.getState().adoptFiles('p1', [file('a.mp3')])
    expect(ok).toBe(false)
    // 明知不齐还去调后端，只会换回一个可预料的 400——先在前端说清楚
    expect(calls.some((c) => c.url.endsWith('/adopt-srt'))).toBe(false)
    expect(usePipeline.getState().byoHint).toBe('已收到配音，还差字幕文件（.srt）')
    expect(usePipeline.getState().error).toBe(null)
  })

  it('先拖配音、再拖字幕，第二次凑齐就派生——服务端已有的那份算数', async () => {
    mockFetch({
      '/assets?kind=srt': ASSET('srt'),
      '/adopt-srt': { cueCount: 3, durationMs: 1000, subtitleMode: 'line', scriptFilled: true, warning: null },
      // 传完字幕后重新拉列表：配音是上一轮传上去的
      '/assets': [ASSET('voice'), ASSET('srt')],
    })
    const ok = await usePipeline.getState().adoptFiles('p1', [file('b.srt')])
    expect(ok).toBe(true)
    expect(usePipeline.getState().byoHint).toBe(null)
  })

  it('认不出的文件不上传，直接说明拒绝原因', async () => {
    const calls = mockFetch({ '/assets': [] })
    const ok = await usePipeline.getState().adoptFiles('p1', [file('片子.mp4')])
    expect(ok).toBe(false)
    expect(calls.some((c) => c.url.includes('kind='))).toBe(false)
    expect(usePipeline.getState().error).toContain('片子.mp4')
    expect(usePipeline.getState().error).toContain('srt')
  })

  it('上传被后端拒绝时，把后端的中文原因原样显示', async () => {
    mockFetch({
      '/assets?kind=srt': { status: 400, error: '字幕文件必须是 .srt（整句时间轴）' },
      '/assets': [],
    })
    const ok = await usePipeline.getState().adoptFiles('p1', [file('b.srt')])
    expect(ok).toBe(false)
    expect(usePipeline.getState().error).toBe('字幕文件必须是 .srt（整句时间轴）')
    expect(usePipeline.getState().byoBusy).toBe(false)
  })

  it('派生返回警告时留住警告，且仍然算成功', async () => {
    mockFetch({
      '/assets?kind=voice': ASSET('voice'),
      '/assets?kind=srt': ASSET('srt'),
      '/adopt-srt': {
        cueCount: 2, durationMs: 2000, subtitleMode: 'line', scriptFilled: false,
        warning: '字幕比配音长 58.0 秒，超出的部分不会出现在成片里。',
      },
      '/assets': [ASSET('voice'), ASSET('srt')],
    })
    const ok = await usePipeline.getState().adoptFiles('p1', [file('a.mp3'), file('b.srt')])
    expect(ok).toBe(true)
    expect(usePipeline.getState().byoWarning).toContain('字幕比配音长')
    expect(usePipeline.getState().byoScriptFilled).toBe(false)
  })

  it('reset 清掉自备相关的临时状态——切项目时不能把上一个的提示带过去', async () => {
    mockFetch({
      '/assets?kind=voice': ASSET('voice'),
      '/assets': [ASSET('voice')],
    })
    await usePipeline.getState().adoptFiles('p1', [file('a.mp3')])
    expect(usePipeline.getState().byoHint).not.toBe(null)
    usePipeline.getState().reset()
    expect(usePipeline.getState().byoHint).toBe(null)
    expect(usePipeline.getState().byoWarning).toBe(null)
    expect(usePipeline.getState().byoScriptFilled).toBe(null)
  })
})
