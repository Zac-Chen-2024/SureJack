/*
 * 人名替换表的截图台：造一份【带小名】的分析结果，看界面怎么渲染。
 * 三种情况都造进去：改好了、改不出来（待你填）、改得不一致（标黄）。
 */
import { chromium } from 'playwright'

const OUT = '/root/SureJack/screenshots/'
const BASE = 'http://127.0.0.1:8809'
const now = new Date('2026-08-05T10:00:00Z').toISOString()

const ANALYSIS = {
  chapterHeadings: [],
  characters: [
    {
      original: '顾文渊', replacement: '顾闻远', role: 'protagonist',
      pairs: [
        { from: '顾文渊', to: '顾闻远', global: true },
        { from: '渊儿', to: '远儿', global: false, contexts: ['「渊儿，进来吧」'] },
        { from: '阿渊', to: '阿缘', global: false, contexts: ['「阿渊，你又在这儿'] },
        { from: '小顾', to: '小顾', global: true },
      ],
    },
    {
      original: '温思言', replacement: '温思妍', role: 'related',
      pairs: [
        { from: '温思言', to: '温思妍', global: true },
        { from: '囡囡', to: '囡囡', global: false, contexts: ['「囡囡别闹」'] },
        { from: '辞哥哥', to: '知哥哥', global: true },
      ],
    },
  ],
  relationships: [{ a: '顾文渊', b: '温思言', label: '青梅竹马' }],
}

const PROJECT = {
  id: 'p1', name: '测试改名', createdAt: now, updatedAt: now,
  coverTitle: '', inVideoTitle: '', watermarkText: '周周',
  openingPickJson: '', splitDraftJson: '', openingState: 'settled',
  parentProjectId: null, episodeIndex: 1,
  scriptText: '顾文渊站在廊下。「渊儿，进来吧。」',
  ttsState: 'none', ttsDurationMs: null, subtitleMode: 'karaoke',
  renameEnabled: true, renameState: 'proposed',
  renameMapJson: JSON.stringify(ANALYSIS),
  renameAnalysisJson: JSON.stringify({ source: '', analysis: ANALYSIS, review: null, reviewError: null }),
}

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true,
})
await page.route('**/*', async (route) => {
  const p = new URL(route.request().url()).pathname
  if (!p.startsWith('/api/')) return route.continue()
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
  if (p === '/api/whoami') return json({ name: '陈梓昂', honorific: '主人' })
  if (p === '/api/projects') return json([PROJECT])
  if (p.endsWith('/subtitles')) return json({ lines: [] })
  if (p.endsWith('/assets')) return json([])
  return json({})
})
page.on('pageerror', (e) => console.log('  [页面报错]', e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
// 从列表点进这条项目（ttsState=none → 会落到「接着完成」那一屏，替换表就在上面）
await page.locator('text=测试改名').first().click()
await page.waitForTimeout(1500)
// 页面是内部滚动的（absolute inset-0 + overflow-y-auto），fullPage 带不到下面
await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find(
    (d) => d.scrollHeight > d.clientHeight + 100 && d.className.includes('overflow-y-auto'))
  if (el) el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}rename-aliases.png` })
console.log('好了：rename-aliases.png')
await browser.close()
