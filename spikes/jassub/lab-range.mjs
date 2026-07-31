import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
await page.goto('http://127.0.0.1:8809/subtitle-lab', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
const setRange = async (idx, v) => page.evaluate(([i, val]) => {
  const r = [...document.querySelectorAll('input[type=range]')][i]
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(r, String(val)); r.dispatchEvent(new Event('input', { bubbles: true }))
}, [idx, v])
const info = await page.evaluate(() => {
  const r = [...document.querySelectorAll('input[type=range]')][1]
  return { min: r.min, max: r.max }
})
console.log('高度滑块范围：', info.min, '→', info.max)
for (const [v, name] of [[info.min, 'bottom'], [Math.round(+info.max/2), 'middle'], [info.max, 'top']]) {
  await setRange(1, v)
  await page.waitForTimeout(250)
  await page.locator('div.relative.shrink-0.overflow-hidden').first().screenshot({ path: `/tmp/lab-${name}.png` })
}
await browser.close()
console.log('三个位置都截了')
