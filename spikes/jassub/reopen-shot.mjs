/* 「重选开头」按钮截图台。纯 mock，不碰任何正式数据 */
import { chromium } from 'playwright'
const OUT = '/root/SureJack/screenshots/'
const now = new Date('2026-08-15T10:00:00Z').toISOString()
const mk = (id, name, headBoundaryMs) => ({
  id, name, createdAt: now, updatedAt: now, coverTitle: '', inVideoTitle: '',
  watermarkText: '', openingPickJson: '', splitDraftJson: '', voiceDraftJson: '',
  archivedAt: '', openingState: 'settled', parentProjectId: null, episodeIndex: 1, scriptText: 'x',
  ttsState: 'ready', ttsDurationMs: 563712, headBoundaryMs,
  subtitleMode: 'karaoke', renameEnabled: false, renameState: 'none',
  bgmLibraryId: null, bgmVolume: 0.15, voiceGain: 2.19,
})
// 新片子有分界；老片子那一列是 null
const P = [mk('p1', '周周隐婚', 152990), mk('p2', '周周双子', null)]
const PLAN = {
  totalMs: 563712,
  segments: [
    ...Array.from({ length: 12 }, (_, i) => ({ bucket: '1-开头', itemId: `k${i}`, filename: `k${i}.mp4`, startMs: 0, takeMs: 12749 })),
    ...Array.from({ length: 5 }, (_, i) => ({ bucket: '2-常规', itemId: `c${i}`, filename: `c${i}.mp4`, startMs: 0, takeMs: 30446 })),
    { bucket: '3-地铁跑酷', itemId: 'p0', filename: 'p0.mp4', startMs: 0, takeMs: 259492 },
  ],
}
const b = await chromium.launch()
async function shot (which, file) {
  const pg = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true })
  await pg.route('**/*', async (r) => {
    const p = new URL(r.request().url()).pathname
    if (!p.startsWith('/api/')) return r.continue()
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) })
    if (p === '/api/whoami') return j({ name: '黄诗婕', honorific: '姑娘' })
    if (p === '/api/projects') return j(P)
    if (p.endsWith('/background-plan')) return j(PLAN)
    if (p.endsWith('/film')) return j({ state: 'ready', jobId: null, progress: 100, error: null, reason: null, masterReady: true })
    if (p.endsWith('/download/state')) return j({ state: 'idle', error: null })
    if (p.endsWith('/subtitles')) return j({ lines: [], mode: 'karaoke', durationMs: 563712 })
    // 兜底：给一个"什么形状都像"的空对象，免得某个没想到的接口把页面打崩
    return j({ items: [], lines: [], segments: [], words: [], state: 'idle', totalMs: 0 })
  })
  pg.on('pageerror', (e) => console.log('  [页面报错]', e.message))
  await pg.goto('http://127.0.0.1:8811', { waitUntil: 'networkidle' })
  await pg.waitForTimeout(2000)
  await pg.locator('li', { hasText: which }).locator('div.cursor-pointer').first().click()
  await pg.waitForSelector('nav', { timeout: 15000 })
  await pg.waitForTimeout(1800)
  await pg.locator('nav button').nth(3).click()
  await pg.waitForTimeout(1500)
  await pg.screenshot({ path: OUT + file })
  console.log(`${file} 好了`)
  await pg.close()
}
await shot('周周隐婚', 'reopen-new.png')
await shot('周周双子', 'reopen-old.png')
await b.close()
