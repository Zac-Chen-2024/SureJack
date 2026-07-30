/*
 * 手机版项目列表的截图台。
 *
 * 不碰真账号、真数据：所有 /api/ 请求都在 Playwright 里拦下来喂假数据，
 * 只加载线上那份【已构建的前端】。这样看到的排版就是用户手机上的排版。
 *
 * ⚠️ 路由匹配必须按 pathname 判断，不能用 `**​/api/**` 这种 glob——
 * 它会把前端自己的 /src/api/client.ts 也拦掉，页面直接白屏（踩过）。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

// 截图落在项目根的 screenshots/。台子本身放在 spikes/jassub/ 是因为
// playwright 只装在那儿的 node_modules 里。
const OUT = '/root/SureJack/screenshots/'

const BASE = 'http://127.0.0.1:8809'

const now = new Date('2026-07-30T10:00:00Z').toISOString()
const project = (id, name, extra = {}) => ({
  id, name, createdAt: now, updatedAt: now,
  scriptText: '他站在楼下等了整整三个小时，直到那扇窗户的灯终于灭了',
  ttsState: 'ready', ttsDurationMs: 92000, subtitleMode: 'word',
  ...extra,
})

const PROJECTS = [
  project('p1', '周周撸铁'),
  project('p2', '深夜食堂的秘密', { ttsState: 'generating', ttsDurationMs: null }),
  project('p3', '老宅里的第七个房间'),
  project('p4', '写了一半的稿子', { ttsState: 'idle', ttsDurationMs: null }),
  project('p5', '被取消的那条'),
]

// p1 合成中 / p5 被取消（列表要显示「未完成」）
const FILM = {
  p1: { state: 'building', progress: 37, masterStale: false },
  p5: { state: 'error', progress: 0, error: '已取消合成' },
}

/*
 * 兜底假数据要【按端点给对形状】。一律回 {} 的话，字幕 store 会拿到
 * undefined 再去读 .length，整个页面白屏——那是台子的锅，不是产品的。
 */
function fallbackBody (pathname) {
  if (pathname.endsWith('/subtitles')) return { lines: [] }
  if (pathname.endsWith('/assets')) return []
  if (pathname.endsWith('/bg-track')) return { state: 'ready', progress: 100 }
  return {}
}

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },   // Pixel 7 那一档
  deviceScaleFactor: 2.5,
  isMobile: true, hasTouch: true,
})

await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  const p = url.pathname
  if (!p.startsWith('/api/')) return route.continue()

  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/whoami') return json({ name: '陈梓昂', honorific: '主人' })
  if (p === '/api/projects') return json(PROJECTS)
  if (p.endsWith('/cover.jpg')) {
    // 真封面（1080x1920 的那张），让列表按"宽度铺满 + 纵向居中"去裁
    return route.fulfill({ status: 200, contentType: 'image/jpeg',
      body: readFileSync('/root/SureJack/screenshots/cover-repro.png') })
  }
  const film = p.match(/^\/api\/projects\/([^/]+)\/film$/)
  if (film) return json(FILM[film[1]] ?? { state: 'ready', progress: 100, masterStale: false })
  return json({})
})

// 原生桥的替身：下载队列悬浮框只在有桥的时候才显示
await page.addInitScript(() => {
  window.SJNative = {
    downloads: () => JSON.stringify([
      { title: '周周撸铁.mp4', total: 48_234_496, done: 31_452_160, status: 'running' },
      { title: '老宅里的第七个房间.mp4', total: 61_000_000, done: 61_000_000, status: 'done' },
    ]),
  }
})

page.on('pageerror', (e) => console.log('  [页面报错]', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()) })
await page.goto(BASE, { waitUntil: 'networkidle' })
// 开屏欢迎页要等它自己淡完
await page.waitForSelector('text=我的项目', { timeout: 15000 })
// 开屏欢迎页盖在上面，得等它整个淡完消失，否则截到的是欢迎页
await page.waitForSelector('text=欢迎回来', { state: 'detached', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(800)
await page.screenshot({ path: OUT + 'list.png' })

// 下载悬浮框
await page.getByLabel('下载队列').click()
await page.waitForTimeout(400)
await page.screenshot({ path: OUT + 'downloads.png' })
await page.getByLabel('关闭', { exact: true }).click()

// 搜索胶囊拉开
await page.getByLabel('打开搜索').click()
await page.waitForTimeout(150)
await page.screenshot({ path: OUT + 'search-mid.png' })
await page.waitForTimeout(400)
await page.keyboard.type('老宅')
await page.waitForTimeout(300)
await page.screenshot({ path: OUT + 'search.png' })

// ── 慢网络下点进一个已完成的项目：/film 迟迟不回，绝不能显示"还没有成片"
await page.getByLabel('关闭搜索').click()
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  const p = url.pathname
  if (p.endsWith('/film')) return new Promise(() => {})            // 永远不回：模拟极慢
  if (p.endsWith('/poster.jpg')) {
    // 一张纯色图冒充成片第一帧
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64')
    return route.fulfill({ status: 200, contentType: 'image/png', body: png })
  }
  if (!p.startsWith('/api/')) return route.continue()
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
  if (p === '/api/whoami') return json({ name: '陈梓昂', honorific: '主人' })
  if (p === '/api/projects') return json(PROJECTS)
  return json(fallbackBody(p))
})
await page.getByText('老宅里的第七个房间').first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: OUT + 'preview-slow.png' })

// ── 成片就绪、但视频流慢：必须显示"视频加载中 xx%"而不是一片黑
await page.route('**/*', async (route) => {
  const p = new URL(route.request().url()).pathname
  if (p.endsWith('/film')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      state: 'ready', jobId: null, progress: 100, error: null, reason: null,
      masterReady: true, masterOnDisk: 'v1', masterVersion: 'v1', masterStale: false,
    }) })
  }
  if (p.includes('/film/master/stream')) return new Promise(() => {})   // 流永远不回
  return route.fallback()
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=欢迎回来', { state: 'detached', timeout: 20000 }).catch(() => {})
await page.getByText('老宅里的第七个房间').first().click()
await page.waitForTimeout(2000)
console.log('  当前可见文本 =', (await page.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | '))
await page.screenshot({ path: OUT + 'video-loading.png' })

await browser.close()
console.log('截好了')
