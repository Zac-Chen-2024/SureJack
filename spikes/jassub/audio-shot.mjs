/* 音频面板截图台：喂真波形（正弦+噪声混出来的包络）和真读数 */
import { chromium } from 'playwright'
const OUT='/root/SureJack/screenshots/'
const now=new Date('2026-08-06T10:00:00Z').toISOString()
const peaks=(f)=>Array.from({length:600},(_,i)=>Math.round(f(i)*1000)/1000)
const AUDIO={
  voice:{lufs:-21.8,truePeak:-3.2,durationMs:633000,
    peaks:peaks(i=>0.25+0.55*Math.abs(Math.sin(i/9))*(0.6+0.4*Math.sin(i/57)))},
  bgm:{lufs:-12.4,truePeak:-1.1,durationMs:480000,
    peaks:peaks(i=>0.45+0.35*Math.abs(Math.sin(i/23)))},
  voiceGain:1, bgmVolume:0.15,
  target:{lufs:-14,truePeak:-1},
  recommended:{voiceGain:1.55,bgmVolume:0.08,musicBelowVoiceDb:10},
}
const P={id:'p1',name:'周周花心',createdAt:now,updatedAt:now,coverTitle:'',inVideoTitle:'',
  watermarkText:'周周',openingPickJson:'',splitDraftJson:'',openingState:'settled',
  parentProjectId:null,episodeIndex:1,scriptText:'测试',ttsState:'ready',ttsDurationMs:633000,
  subtitleMode:'karaoke',renameEnabled:false,renameState:'none',bgmLibraryId:'bgm-1',bgmVolume:0.15,voiceGain:1}
const b=await chromium.launch()
const pg=await b.newPage({viewport:{width:412,height:915},deviceScaleFactor:2.5,isMobile:true,hasTouch:true})
await pg.route('**/*',async(r)=>{
  const p=new URL(r.request().url()).pathname
  if(!p.startsWith('/api/')) return r.continue()
  const j=(x)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)})
  if(p==='/api/whoami') return j({name:'陈梓昂',honorific:'主人'})
  if(p==='/api/projects') return j([P])
  if(p.endsWith('/audio')) return j(AUDIO)
  if(p.endsWith('/film')) return j({state:'none',jobId:null,progress:0,error:null,reason:null})
  // 素材库返回的是【文件名】，前端自己切曲名（parseBgmName 用 lastIndexOf）
  if(p.includes('/library')) return j({items:[
    {id:'bgm-1',bucket:'背景音乐',filename:'一笑倾城 温柔.mp3',durationMs:480000,sizeBytes:1},
    {id:'bgm-2',bucket:'背景音乐',filename:'傻女 怀旧.mp3',durationMs:520000,sizeBytes:1},
  ]})
  return j({})
})
pg.on('pageerror',(e)=>console.log('  [页面报错]',e.message))
await pg.goto('http://127.0.0.1:8809',{waitUntil:'networkidle'})
await pg.waitForTimeout(2500)
await pg.locator('text=周周花心').first().click()
await pg.waitForTimeout(1500)
const tab=pg.locator('button:has-text("音频")').first()
if(await tab.count()){ await tab.click(); await pg.waitForTimeout(1200) }
await pg.screenshot({path:`${OUT}audio-panel.png`})
console.log('好了')
await b.close()
