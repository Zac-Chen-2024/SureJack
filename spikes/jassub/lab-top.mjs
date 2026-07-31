/* 拉到上限时，字幕墨迹顶边离画面顶还剩多少（成片坐标） */
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })
await page.goto('http://127.0.0.1:8809/subtitle-lab', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
for (const FS of [36, 64, 120]) {
  await page.evaluate((fs) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const rs = [...document.querySelectorAll('input[type=range]')]
    set.call(rs[0], String(fs)); rs[0].dispatchEvent(new Event('input', { bubbles: true }))
  }, FS)
  await page.waitForTimeout(150)
  const max = await page.evaluate(() => [...document.querySelectorAll('input[type=range]')][1].max)
  await page.evaluate((m) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const r = [...document.querySelectorAll('input[type=range]')][1]
    set.call(r, m); r.dispatchEvent(new Event('input', { bubbles: true }))
  }, max)
  await page.waitForTimeout(150)
  const m = await page.evaluate(() => {
    const stage = document.querySelector('img[alt=""]').parentElement
    const sub = [...stage.querySelectorAll('div')].find((d) => d.textContent.includes('座右铭'))
    const sr = stage.getBoundingClientRect()
    const r = document.createRange(); r.selectNodeContents(sub)
    const tr = r.getBoundingClientRect()
    return { stageW: sr.width, stageH: sr.height, top: tr.top - sr.top, bottom: tr.bottom - sr.top }
  })
  const k = 1080 / m.stageW
  console.log(`字号 ${FS.toString().padStart(3)}  上限 ${max}  →  字块顶边离画面顶 ${Math.round(m.top*k)}（负数=切了）`)
}
await browser.close()
