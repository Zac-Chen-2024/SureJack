import { chromium } from 'playwright'
const browser = await chromium.launch()
for (const [name, vp, mobile] of [
  ['lab-phone', { width: 412, height: 915 }, true],
  ['lab-desktop', { width: 1280, height: 900 }, false],
]) {
  const page = await browser.newPage({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2.5 : 1.5 })
  page.on('pageerror', (e) => console.log('  [报错]', e.message))
  await page.goto('http://127.0.0.1:8809/subtitle-lab', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `/root/SureJack/screenshots/${name}.png` })
  if (mobile) {
    // 点提交，看回执
    await page.getByText('提交这组参数').click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: '/root/SureJack/screenshots/lab-submitted.png' })
    console.log('  提交后文本 =', (await page.locator('body').innerText()).split('\n').slice(-4).join(' | '))
  }
  await page.close()
}
await browser.close()
console.log('截好了')
