/*
 * 挑开头那一屏的截图台。
 *
 * 和 list-shot.mjs 同一套路：只加载线上那份【已构建的前端】，
 * 所有 /api/ 请求在 Playwright 里拦下来喂假数据，不碰真账号真项目。
 * 缩略图用真素材库里已经生成好的那 68 张（读文件直接 fulfill），
 * 这样看到的排版就是用户手机上的排版。
 *
 * ⚠️ 路由匹配按 pathname 判断，不能用 `**​/api/**` 那种 glob——
 * 它会把前端自己的 /src/api/client.ts 也拦掉，页面直接白屏（踩过）。
 */
import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'

const OUT = '/root/SureJack/screenshots/'
const BASE = 'http://127.0.0.1:8809'
const THUMBS = '/root/SureJack/data/library/_thumbs'

const thumbFiles = readdirSync(THUMBS).filter((f) => f.endsWith('.jpg'))
// 真素材：挑几条短的，够验证"接缝换段"就行
const LIB = '/root/SureJack/data/library/1-开头'
const realClips = readdirSync(LIB).filter((f) => f.endsWith('.mp4')).slice(0, 6)

const now = new Date('2026-08-01T10:00:00Z').toISOString()
// 开头桶：68 条，时长在 8~34 秒之间（真库里就是这个量级）
const ITEMS = thumbFiles.map((f, i) => ({
  id: `open-${i}`,
  bucket: '1-开头',
  filename: `开头-${String(i).padStart(2, '0')}.mp4`,
  durationMs: 8000 + (i * 3700) % 26000,
  sizeBytes: 1_000_000,
}))

const PROJECTS = [
  {
    id: 'm1', name: '周周撸铁', createdAt: now, updatedAt: now,
    coverTitle: '周周撸铁', inVideoTitle: '周周撸铁', parentProjectId: null, episodeIndex: 1,
    scriptText: '正文', ttsState: 'ready', ttsDurationMs: 240000,
    subtitleMode: 'word', openingState: 'pending',
  },
  {
    id: 'm2', name: '周周撸铁2', createdAt: now, updatedAt: now,
    coverTitle: '周周撸铁2', inVideoTitle: '周周撸铁', parentProjectId: 'm1', episodeIndex: 2,
    scriptText: '正文', ttsState: 'none', ttsDurationMs: 226000,
    subtitleMode: 'word', openingState: 'pending',
  },
]

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.5,
  isMobile: true, hasTouch: true,
})

await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  const p = url.pathname
  if (!p.startsWith('/api/')) return route.continue()

  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  // 缩略图：把真图直接喂回去
  const m = /^\/api\/library\/items\/open-(\d+)\/thumb$/.exec(p)
  if (m) {
    return route.fulfill({
      status: 200, contentType: 'image/jpeg',
      body: readFileSync(`${THUMBS}/${thumbFiles[Number(m[1]) % thumbFiles.length]}`),
    })
  }
  // 素材本体：把真 mp4 的字节喂回去，好让"连着看"真的能播
  const clip = /^\/api\/library\/items\/open-(\d+)$/.exec(p)
  if (clip) {
    return route.fulfill({
      status: 200, contentType: 'video/mp4',
      body: readFileSync(`${LIB}/${realClips[Number(clip[1]) % realClips.length]}`),
    })
  }
  if (p === '/api/whoami') return json({ name: '陈梓昂', honorific: '主人' })
  if (p === '/api/projects') return json(PROJECTS)
  if (p.startsWith('/api/library/')) return json({ items: ITEMS })
  if (p.endsWith('/subtitles')) return json({ lines: [] })
  if (p.endsWith('/assets')) return json([])
  return json({})
})

page.on('pageerror', (e) => console.log('  [页面报错]', e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
// 开屏欢迎页要等它自己淡完
await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}opening-debug-list.png` })
// 从列表点进"待挑开头"的那条项目
// 点【第 1 集那一行】，不是文件夹标题——标题不是可点的入口
const card = page.locator('text=第 1 集').first()
await card.waitFor({ timeout: 10000 })
await card.click()
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}opening-empty.png` })

// 挑 5 段
for (const i of [0, 3, 5, 8, 11, 13, 14, 15, 16, 17]) {
  await page.locator('button:has(img)').nth(i).click()
  await page.waitForTimeout(140)
}
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}opening-picked.png` })

// 连着看一遍：截两个时刻，看它是不是真的在往下走
await page.getByLabel('连着看一遍').click()
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}opening-preview-1.png` })
const seen = await page.evaluate(() => {
  const vs = [...document.querySelectorAll('video')]
  return vs.map((v) => ({ t: v.currentTime, dur: v.duration, src: v.src.split('/').pop(), vis: v.className.includes('opacity-100') }))
})
console.log('预览里的两个 video：', JSON.stringify(seen))
// 等第一段放完（6.1 秒），看有没有换到第二段、以及第三段有没有补上
await page.waitForTimeout(5000)
const after = await page.evaluate(() => {
  const vs = [...document.querySelectorAll('video')]
  return vs.map((v) => ({ t: +v.currentTime.toFixed(2), src: v.src.split('/').pop(), vis: v.className.includes('opacity-100') }))
})
console.log('换段之后：', JSON.stringify(after))
await page.screenshot({ path: `${OUT}opening-preview-2.png` })
console.log('好了：opening-empty.png / opening-picked.png / opening-preview-1.png')
await browser.close()
