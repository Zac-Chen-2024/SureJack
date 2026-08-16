/* 配音失败的项目点进去，应该落在文案页、按钮可点 */
import { chromium } from 'playwright'
const now = '2026-08-16T10:00:00Z'
const P = [{
  id: 'p1', name: '周周日光', createdAt: now, updatedAt: now, touchedAt: now, archivedAt: '',
  downloadedAt: '', coverTitle: '', inVideoTitle: '', watermarkText: '周周',
  openingPickJson: '', splitDraftJson: '', voiceDraftJson: '', openingState: 'settled',
  parentProjectId: null, episodeIndex: 1, scriptText: '他站在门口，我没有回头，'.repeat(40),
  ttsState: 'error', ttsDurationMs: null, headBoundaryMs: null, layoutRatioJson: null,
  subtitleMode: 'karaoke', renameEnabled: true, renameState: 'confirmed',
  renameAnalysisJson: null, renameMapJson: '{"人物":[]}',
  bgmLibraryId: null, bgmVolume: 0.15, voiceGain: 2.19,
}]
const b = await chromium.launch()
const pg = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const errs = []
pg.on('pageerror', (e) => errs.push('页面报错: ' + e.message))
await pg.route('**/*', async (r) => {
  const p = new URL(r.request().url()).pathname
  if (!p.startsWith('/api/')) return r.continue()
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) })
  if (p === '/api/whoami') return j({ name: '黄诗婕', honorific: '姑娘' })
  if (p === '/api/projects') return j(P)
  if (p.endsWith('/film')) return j({ state: 'none', jobId: null, progress: 0, error: null, reason: null, masterReady: false })
  return j({ items: [], lines: [], segments: [], words: [], state: 'idle', totalMs: 0 })
})
await pg.goto('http://127.0.0.1:8811', { waitUntil: 'networkidle' })
await pg.waitForTimeout(2200)
await pg.locator('li', { hasText: '周周日光' }).locator('div.cursor-pointer').first().click()
await pg.waitForTimeout(2500)
const txt = (await pg.locator('body').innerText()).replace(/\n+/g, ' | ')
console.log('落在哪一屏:', txt.slice(0, 200))
const gen = pg.getByText(/生成配音并合成/).first()
const has = await gen.count() > 0
console.log('有「生成配音并合成视频」按钮吗:', has ? '✅ 有' : '❌ 没有')
if (has) {
  const el = await gen.elementHandle()
  const disabled = await el.evaluate((n) => (n.closest('button') ?? n).disabled === true)
  console.log('按钮能点吗:', disabled ? '❌ 是灰的' : '✅ 可点')
}
console.log('还看得到「接着上次继续」吗:', await pg.getByText('接着上次继续').count() > 0 ? '❌ 还在' : '✅ 没有了')
await pg.screenshot({ path: '/root/SureJack/screenshots/voicefail.png' })
console.log(errs.length ? '❌ ' + errs.join(' / ') : '✅ 没有脚本报错')
await b.close()
