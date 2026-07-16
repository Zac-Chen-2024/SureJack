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
  catch { console.log('  404 →', p); res.writeHead(404); res.end('nf'); return }
  res.writeHead(200,{'Content-Type':MIME[extname(p)]??'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'})
  res.end(body)
})
await new Promise(r=>server.listen(8099,r))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport:{width:1080,height:1920} })
page.on('console', m => console.log('  [c]', m.text()))
page.on('pageerror', e => console.log('  [err]', e.message))
await page.goto('http://127.0.0.1:8099/isolate.html')
await page.waitForFunction('window.__done', null, {timeout:60000}).catch(()=>console.log('  ⚠ 超时'))
console.log('  结果 =', JSON.stringify(await page.evaluate('window.__result')))
await page.locator('#c').screenshot({ path: join(ROOT,'isolate.png') })
await browser.close(); server.close()
