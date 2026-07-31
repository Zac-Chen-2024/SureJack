/* 验一下"界面过期"横幅：先加载页面，再把 build.json 换成另一个 sha，看它跳不跳 */
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })
let sha = null   // null = 用真实的
await page.route('**/*', async (route) => {
  const p = new URL(route.request().url()).pathname
  if (p === '/build.json' && sha) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha, time: 'x' }) })
  }
  if (!p.startsWith('/api/')) return route.continue()
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
  if (p === '/api/whoami') return json({ name: '陈梓昂', honorific: '主人' })
  if (p === '/api/projects') return json([])
  if (p.endsWith('/subtitles')) return json({ lines: [] })
  return json({})
})
await page.goto('http://127.0.0.1:8809', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=欢迎回来', { state: 'detached', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(500)
console.log('初始有没有横幅：', await page.locator('text=界面有更新').count() > 0 ? '有（不对）' : '没有（对）')

// 服务端"部署了新版"
sha = 'deadbee'
// 切走再切回来，模拟原生壳恢复
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
await page.waitForTimeout(800)
const shown = await page.locator('text=界面有更新').count() > 0
console.log('服务端换版后切回来：', shown ? '弹出横幅（对）' : '没弹（不对）')
if (shown) await page.screenshot({ path: '/root/SureJack/screenshots/stale-banner.png' })
await browser.close()
