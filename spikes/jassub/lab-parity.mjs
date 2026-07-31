/* 量网页里那行字幕的真实像素，换算回成片坐标系，和真烧的对比 */
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })
await page.goto('http://127.0.0.1:8809/subtitle-lab', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)   // 等 webfont 加载完，不然量到的是回退字体
// 两个字号各量一次：补正是按字号线性缩放的，只验一个点等于没验
for (const FS of [64, 96]) {
await page.evaluate((fs) => {
  const r = [...document.querySelectorAll('input[type=range]')][0]
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(r, String(fs))
  r.dispatchEvent(new Event('input', { bubbles: true }))
}, FS)
await page.waitForTimeout(200)
const m = await page.evaluate(() => {
  const stage = document.querySelector('img[alt=""]').parentElement
  const sub = stage.querySelector('div[style*="paint-order"], div[style*="paintOrder"]')
    ?? [...stage.querySelectorAll('div')].find((d) => d.textContent.includes('座右铭'))
  const sr = stage.getBoundingClientRect()
  const r = document.createRange()
  r.selectNodeContents(sub)
  const tr = r.getBoundingClientRect()
  return {
    stageW: sr.width, stageH: sr.height,
    textLeft: tr.left - sr.left, textRight: tr.right - sr.left,
    textTop: tr.top - sr.top, textBottom: tr.bottom - sr.top,
  }
})
const k = 1080 / m.stageW
console.log(`预览画面 ${Math.round(m.stageW)}x${Math.round(m.stageH)}，换算系数 ${k.toFixed(3)}`)
console.log(`网页：x ${Math.round(m.textLeft*k)}..${Math.round(m.textRight*k)} (宽 ${Math.round((m.textRight-m.textLeft)*k)})`)
console.log(`      底边距 ${Math.round((m.stageH - m.textBottom)*k)}`)
console.log(`  ↑ 字号 ${FS}`)
}
console.log('\n真烧 F=64: 宽 662 底边距 308     F=96: 宽 993 底边距 312')
await browser.close()
