import { chromium } from 'playwright'
const OUT='/root/SureJack/screenshots/'
const b=await chromium.launch()
const pg=await b.newPage({viewport:{width:412,height:915},deviceScaleFactor:2.5,isMobile:true,hasTouch:true})
await pg.route('**/*',async(r)=>{
  const p=new URL(r.request().url()).pathname
  if(!p.startsWith('/api/')) return r.continue()
  const j=(x)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)})
  if(p==='/api/whoami') return j({name:'陈梓昂',honorific:'主人'})
  if(p==='/api/projects') return j([])
  return j({})
})
pg.on('pageerror',(e)=>console.log('  [页面报错]',e.message))
await pg.goto('http://127.0.0.1:8809',{waitUntil:'networkidle'})
await pg.waitForTimeout(2500)
const nw=pg.locator('text=新建项目').first()
if(await nw.count()){ await nw.click(); await pg.waitForTimeout(1200) }
// 勾上「自动创建续集」，子选项才会出现
const cb=pg.locator('input[type=checkbox]').first()
if(await cb.count()){ await cb.check(); await pg.waitForTimeout(500) }
await pg.screenshot({path:`${OUT}sequel-only.png`})
console.log('好了')
await b.close()
