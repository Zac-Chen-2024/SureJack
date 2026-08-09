/* 下载队列 + 列表菜单截图台 */
import { chromium } from 'playwright'
const OUT='/root/SureJack/screenshots/'
const now=new Date('2026-08-08T10:00:00Z').toISOString()
const mk=(id,name,tts)=>({id,name,createdAt:now,updatedAt:now,coverTitle:'',inVideoTitle:'',
  watermarkText:'周周',openingPickJson:'',splitDraftJson:'',voiceDraftJson:'',openingState:'settled',
  parentProjectId:null,episodeIndex:1,scriptText:'x',ttsState:tts,ttsDurationMs:600000,
  subtitleMode:'karaoke',renameEnabled:false,renameState:'none',bgmLibraryId:null,bgmVolume:0.15,voiceGain:1})
const P=[mk('p1','周周情蛊','ready'), mk('p2','周周迷香','ready')]
const b=await chromium.launch()
const pg=await b.newPage({viewport:{width:412,height:915},deviceScaleFactor:2.5,isMobile:true,hasTouch:true})
await pg.route('**/*',async(r)=>{
  const u=new URL(r.request().url()); const p=u.pathname
  if(!p.startsWith('/api/')) return r.continue()
  const j=(x)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)})
  if(p==='/api/whoami') return j({name:'黄诗婕',honorific:'姑娘'})
  if(p==='/api/projects') return j(P)
  if(p.endsWith('/film')) return j({state:'ready',jobId:null,progress:100,error:null,reason:null,masterReady:true})
  if(p.endsWith('/download/prepare')) return j({state:'mixing',error:null})
  if(p.endsWith('/download/state')) return j({state:'mixing',error:null})
  return j({})
})
pg.on('pageerror',(e)=>console.log('  [页面报错]',e.message))
await pg.goto('http://127.0.0.1:8809',{waitUntil:'networkidle'})
await pg.waitForTimeout(2500)
// 打开第一行的 ⋮ 菜单
const more=pg.locator('button[aria-label="更多"]').first()
if(await more.count()){ await more.click(); await pg.waitForTimeout(600) }
await pg.screenshot({path:`${OUT}list-download-menu.png`})
console.log('菜单截图好了')
// 点「下载 · 我的音量」→ ghost + 队列
const item=pg.locator('text=下载 · 我的音量').first()
if(await item.count()){ await item.click(); await pg.waitForTimeout(700) }
await pg.screenshot({path:`${OUT}download-ghost.png`})
console.log('ghost 截图好了')
await b.close()
