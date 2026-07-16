import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
const ROOT = '/root/SureJack/spikes/jassub/'
const MIME = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.ass':'text/plain','.ttc':'font/collection','.map':'application/json','.woff2':'font/woff2','.json':'application/json'}
const server = createServer((req,res)=>{
  const p = decodeURIComponent(req.url.split('?')[0])
  let body
  try { body = readFileSync(join(ROOT, p==='/'?'index.html':p)) }
  catch { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200,{'Content-Type':MIME[extname(p)]??'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'})
  res.end(body)
})
await new Promise(r=>server.listen(8099,r))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport:{width:540,height:960} })
await page.goto('http://127.0.0.1:8099/index.html?t=3.0')
await page.waitForFunction('window.__spike?.ready || window.__spike?.error', null, {timeout:60000})
await page.waitForTimeout(2500)

// 对照：普通 2D canvas 能否被截到？验证截图链路本身
const sanity = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width=100; c.height=100
  c.id = 'sanity'; c.style.position='fixed'; c.style.top='0'; c.style.left='0'
  const x = c.getContext('2d'); x.fillStyle='#ff00ff'; x.fillRect(0,0,100,100)
  document.body.appendChild(c)
  return 'ok'
})
await page.screenshot({ path: join(ROOT,'fullpage.png') })
console.log('  整页截图已保存')
await browser.close(); server.close()
