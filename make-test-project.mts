import { openUserDb } from './src/db/user-db.js'
import { openLibraryDb } from './src/library/library-db.js'
import { planProjectBackground, openingIdsOf } from './src/library/background.js'
import { synthesizeLong } from './src/tts/index.js'
import { headBoundary } from './src/subtitles/head-boundary.js'
import { deriveSubtitleLines } from './src/subtitles/project-ass.js'
import { assetDir } from './src/assets/storage.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const U = '陈梓昂'
const W = ['陈梓昂', '黄诗婕']

/* 逗号分隔——现在配音和分句都只认逗号，没有句末标点 */
const TEXT = [
  '结婚三年，他从没在家里过过一次生日，',
  '今年我照旧订了蛋糕，插好蜡烛，等到十一点半，',
  '门开了，他身上带着一股陌生的香水味，',
  '我说了句生日快乐，他愣了一下，问我今天几号，',
  '我把蛋糕推过去，他没接，只说公司还有事，',
  '第二天我去了他公司楼下，前台说，',
  '林总昨天下午就请假了，说是陪太太过生日，',
  '我站在大厅里笑出了声，',
  '原来这三年，我连一个称呼都不是',
].join('')

console.log('文案', TEXT.length, '字')

const db0 = openUserDb(U, W)
const p0 = db0.createProject('重选开头测试')
db0.updateProject(p0.id, { scriptText: TEXT })
db0.close()
console.log('项目建好', p0.id)

const dir = assetDir(U, W, p0.id)
await mkdir(dir, { recursive: true })
const outPath = join(dir, 'voice.mp3')

console.log('配音中（真 Azure）…')
const r = await synthesizeLong({
  text: TEXT, outPath,
  key: process.env.AZURE_SPEECH_KEY!, region: process.env.AZURE_SPEECH_REGION!,
  voice: p0.voiceName, rate: p0.voiceRate, volume: p0.voiceVolume, pitch: p0.voicePitch,
})
console.log(`配音好了 ${(r.durationMs / 1000).toFixed(1)}s，${r.words.length} 个词时间戳`)

{
  const db = openUserDb(U, W)
  db.addAsset({ projectId: p0.id, kind: 'voice', path: outPath, originalName: 'voice.mp3', size: 0, durationMs: r.durationMs })
  db.updateProject(p0.id, { ttsState: 'ready', ttsDurationMs: r.durationMs, wordTimingsJson: JSON.stringify(r.words) })
  db.close()
}

// 和 tts/routes.ts 的 settleHeadBoundary 同一套逻辑
{
  const db = openUserDb(U, W)
  const p = db.getProject(p0.id)!
  const b = headBoundary(deriveSubtitleLines(p), p.ttsDurationMs ?? 0)
  if (b === null) { console.log('⚠️ 算不出分界'); db.close(); process.exit(1) }
  db.updateProject(p0.id, { headBoundaryMs: b.endMs })
  db.close()
  console.log(`分界 = 第 ${b.lineIndex + 1} 句句尾，${(b.endMs / 1000).toFixed(2)}s（占全片 ${(b.endMs / r.durationMs * 100).toFixed(0)}%）`)
}

// 先给一套默认开头并放行，省得他第一次还要挑一遍
{
  const lib = openLibraryDb('data')
  const db = openUserDb(U, W)
  const p = db.getProject(p0.id)!
  const pick = openingIdsOf(planProjectBackground(lib, p.id, p.ttsDurationMs, { headBoundaryMs: p.headBoundaryMs }))
  db.updateProject(p0.id, { openingPickJson: JSON.stringify(pick), openingState: 'settled' })
  const dur = new Map(pick.map((id) => [id, 0]))
  console.log(`默认开头 ${pick.length} 段：`, pick.map((x) => x.split('/')[1]).join(' · '))
  db.close(); lib.close()
}
console.log('\n好了。打开 App 里的「重选开头测试」，它会自己开始合成。')
