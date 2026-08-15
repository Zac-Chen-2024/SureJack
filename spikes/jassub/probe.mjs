import { chromium } from 'playwright'
const b = await chromium.launch()
const pg = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await pg.route('**/*', async (r) => {
  const p = new URL(r.request().url()).pathname
  if (!p.startsWith('/api/')) return r.continue()
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) })
  if (p === '/api/whoami') return j({ name: '黄诗婕', honorific: '姑娘' })
  if (p === '/api/projects') return j([{ id: 'p1', name: '周周隐婚', createdAt: '2026-08-15T10:00:00Z', updatedAt: '2026-08-15T10:00:00Z', coverTitle: '', inVideoTitle: '', watermarkText: '', openingPickJson: '', splitDraftJson: '', voiceDraftJson: '', archivedAt: '', openingState: 'settled', parentProjectId: null, episodeIndex: 1, scriptText: 'x', ttsState: 'ready', ttsDurationMs: 563712, headBoundaryMs: 152990, subtitleMode: 'karaoke', renameEnabled: false, renameState: 'none', bgmLibraryId: null, bgmVolume: 0.15, voiceGain: 2.19 }])
  return j({})
})
pg.on('console', (m) => console.log('  [console]', m.text().slice(0, 200)))
pg.on('pageerror', (e) => console.log('  [页面报错]', e.message))
await pg.goto('http://127.0.0.1:8811', { waitUntil: 'networkidle' })
await pg.waitForTimeout(2500)
await pg.evaluate(() => { window.__err = []; window.addEventListener('error', (e) => window.__err.push(String(e.message))) })
await pg.locator('li', { hasText: '周周隐婚' }).locator('div.cursor-pointer').first().dispatchEvent('click')
await pg.waitForTimeout(2500)
console.log('  错误 =', JSON.stringify(await pg.evaluate(() => window.__err)))
console.log('  history.state =', JSON.stringify(await pg.evaluate(() => history.state)))
console.log('  nav 数 =', await pg.locator('nav').count())
console.log('  li 数 =', await pg.locator('li').count(), '点击元素数 =', await pg.locator('li >> div.cursor-pointer').count())
console.log('  正文开头 =', (await pg.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | '))
const html = await pg.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === '周周隐婚')
  let n = el, path = []
  while (n && path.length < 6) { path.push(n.tagName + '.' + (n.className || '').toString().slice(0, 60)); n = n.parentElement }
  return path
})
console.log(html.join('\n'))
await b.close()
