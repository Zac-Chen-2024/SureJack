/*
 * 挑开头这条链路的真机验收。
 *
 * 走【真 HTTP 路由】（fastify.inject）、真素材库、真用户数据目录、真 Azure 配音、
 * 真烧录——不是调内部函数。会话用一个内存 auth 库现开，不动线上那份。
 *
 * 文案故意写得很短：配音十几秒就好，Azure 花销可忽略，烧录也只有一两分钟。
 */
import { readFileSync } from 'node:fs'
import { buildServer } from '/root/SureJack/src/server.ts'
import { openUserDb } from '/root/SureJack/src/db/user-db.ts'

// .env 里是 Azure 的 key，服务是靠 systemd 的 EnvironmentFile 注进去的
for (const line of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (m) process.env[m[1]] = m[2]
}

const USER = '陈梓昂'
const WL = ['陈梓昂', '黄诗婕']
const app = buildServer({ authDbPath: ':memory:', whitelist: WL, cookieSecret: 'e2e-secret-32-chars-long-abcdefgh' })
await app.ready()

const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: USER, password: 'e2e-pass-1234' } })
const cookie = login.cookies.find((c) => c.name === 'sj_session').value
const call = (method, url, payload) => app.inject({ method, url, payload, cookies: { sj_session: cookie } })
const proj = (id) => {
  const db = openUserDb(USER, WL)
  try { return db.getProject(id) } finally { db.close() }
}
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? '✓' : '✗ 【不对】'} ${label}${extra ? '  ' + extra : ''}`)

// ── 0 清掉上一轮的测试项目 ──────────────────────────────────────────
{
  const db = openUserDb(USER, WL)
  try {
    for (const p of db.listProjects().filter((x) => x.name.startsWith('开头自选验收'))) {
      db.deleteProject(p.id)
      console.log(`清掉上一轮的 ${p.name} ${p.id.slice(0, 8)}`)
    }
  } finally { db.close() }
}

// ── 1 建项目 + 写文案 ────────────────────────────────────────────────
const created = await call('POST', '/api/projects', { name: '开头自选验收' })
const id = JSON.parse(created.body).id
await call('PATCH', `/api/projects/${id}`, {
  scriptText: '他把那只旧木箱推到墙角，箱子里只剩半张泛黄的照片。照片背面写着一行小字，墨迹早就淡了。他盯着看了很久，最后还是把箱子盖上了。',
})
/*
 * 关掉人名替换。这不是绕过检查——配音那道门要的是"人名替换已经有结论"，
 * 真人流程里是在替换表那一屏确认的，脚本走不到那一屏。关掉等于用户选了不改名。
 */
await call('POST', `/api/projects/${id}/rename/toggle`, { enabled: false })
console.log(`项目 ${id.slice(0, 8)} 建好了（人名替换已关）`)

// ── 2 挂起 ──────────────────────────────────────────────────────────
await call('POST', `/api/projects/${id}/opening/hold`)
ok('hold 之后状态是 pending', proj(id).openingState === 'pending')

// ── 3 真配音 ────────────────────────────────────────────────────────
console.log('配音中（真调 Azure）…')
const voice = await call('POST', `/api/projects/${id}/voice`)
ok('配音成功', voice.statusCode === 200, voice.statusCode === 200 ? `${JSON.parse(voice.body).durationMs} ms` : voice.body.slice(0, 120))

// ── 4 闸门：配音好了也不该开始合成 ──────────────────────────────────
await new Promise((r) => setTimeout(r, 1500))
const film = await call('GET', `/api/projects/${id}/film`)
const st = JSON.parse(film.body)
ok('配音完成后【没有】自动开烧', st.state !== 'building' && st.state !== 'ready', `film.state=${st.state}`)
ok('这时候仍然是 pending', proj(id).openingState === 'pending')

// ── 5 挑三段开头 ────────────────────────────────────────────────────
const bucket = JSON.parse((await call('GET', `/api/library/${encodeURIComponent('1-开头')}`)).body)
const pick = [bucket.items[2].id, bucket.items[7].id, bucket.items[11].id]
const bad = await call('POST', `/api/projects/${id}/opening`, { pick: [...pick, '查无此段'] })
ok('脏 id 被拒（400）', bad.statusCode === 400, JSON.parse(bad.body).error ?? '')

const settled = await call('POST', `/api/projects/${id}/opening`, { pick })
ok('敲定成功', settled.statusCode === 200)
ok('落库的清单就是挑的那三段', JSON.stringify(JSON.parse(proj(id).openingPickJson)) === JSON.stringify(pick))
ok('状态翻成 settled', proj(id).openingState === 'settled')

// ── 6 排布真的按挑的来 ──────────────────────────────────────────────
const plan = JSON.parse((await call('GET', `/api/projects/${id}/background-plan`)).body)
const openingSegs = plan.segments.filter((s) => s.bucket === '1-开头').map((s) => s.itemId)
ok('排布的开头段 = 挑的那几段', JSON.stringify(openingSegs) === JSON.stringify(pick.slice(0, openingSegs.length)),
  `排布里 ${openingSegs.length} 段`)

// ── 7 续集的默认要避开主片 ──────────────────────────────────────────
const kidRes = await call('POST', '/api/projects', { name: '开头自选验收2' })
const kid = JSON.parse(kidRes.body).id
await call('POST', `/api/projects/${kid}/rename/toggle`, { enabled: false })
{
  const db = openUserDb(USER, WL)
  try {
    db.updateProject(kid, { parentProjectId: id, episodeIndex: 2, ttsDurationMs: 60000, ttsState: 'ready' })
  } finally { db.close() }
}
await call('POST', `/api/projects/${kid}/opening`, { pick: [] })   // 用默认素材
const kidPick = JSON.parse(proj(kid).openingPickJson)
ok('续集用默认也物化成了具体清单', kidPick.length > 0, `${kidPick.length} 段`)
ok('续集一段都没和主片撞', kidPick.every((x) => !pick.includes(x)))

// ── 8 敲定之后真的排上队并烧出来 ────────────────────────────────────
console.log('等烧录…')
let last = ''
for (let i = 0; i < 120; i++) {
  const s = JSON.parse((await call('GET', `/api/projects/${id}/film`)).body)
  if (s.state !== last) { console.log(`  film.state = ${s.state} ${s.progress ?? ''}`); last = s.state }
  if (s.state === 'ready' || s.state === 'error') break
  await new Promise((r) => setTimeout(r, 5000))
}
const final = JSON.parse((await call('GET', `/api/projects/${id}/film`)).body)
ok('成片烧出来了', final.state === 'ready', `state=${final.state} ${final.error ?? ''}`)
console.log(`\n项目 id：${id}\n续集 id：${kid}`)
await app.close()
