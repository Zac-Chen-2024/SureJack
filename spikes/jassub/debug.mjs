import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
const ROOT = '/root/SureJack/spikes/jassub/'
const MIME = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.ass':'text/plain','.ttc':'font/collection','.map':'application/json','.woff2':'font/woff2','.json':'application/json'}
const server = createServer((req,res)=>{
  const p = decodeURIComponent(req.url.split('?')[0])
  try {
    const body = readFileSync(join(ROOT, p==='/'?'index.html':p))
    res.writeHead(200,{'Content-Type':MIME[extname(p)]??'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    res.end(body)
  } catch(e){ console.log('  404 →', p); res.writeHead(404).end('nf') }
})
await new Promise(r=>server.listen(8099,r))
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', m => console.log('  [console]', m.type(), m.text()))
page.on('pageerror', e => console.log('  [pageerror]', e.message))
page.on('worker', w => console.log('  [worker启动]', w.url().replace('http://127.0.0.1:8099','')))
page.on('requestfailed', r => console.log('  [请求失败]', r.url().replace('http://127.0.0.1:8099',''), r.failure()?.errorText))
await page.goto('http://127.0.0.1:8099/index.html?t=3.0')
await page.waitForTimeout(8000)
console.log('  __spike =', JSON.stringify(await page.evaluate('window.__spike')))
await browser.close(); server.close()
