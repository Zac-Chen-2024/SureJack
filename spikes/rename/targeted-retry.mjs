/*
 * 实验：没换干净的名字，【单独发小请求重试】，不重跑整篇。
 *
 * 现在的做法是整篇重跑最多两次、保留"最好的那一份"——最好的那一份仍然
 * 可能带着一个没换的字。而且重跑整篇既慢又贵，模型每次还会把别的名字
 * 也换一遍，用户刚看顺眼的又变了。
 *
 * 这里试的是：整篇只跑一次，之后【只把出问题的那几个名字】发过去，
 * 一次一个、上下文极小，问题也极具体——"这几个字没换，给我同音的另一个字"。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2]
}
import { openUserDb } from '/root/SureJack/src/db/user-db.ts'
import { analyzeNovel, findIdentityViolations, unchangedGivenChars } from '/root/SureJack/src/rename/deepseek.ts'
import { pinyin } from 'pinyin-pro'

const KEY = process.env.DEEPSEEK_API_KEY

/** 只问一个名字的一小步请求 */
async function fixOne (original, replacement, stuck) {
  const sys = `你是中文谐音改名器。只回 JSON，不要解释。

用户给你一个原名和一版改名，其中【某几个字没有换掉】。
你要把这几个字换成【读音完全相同、字不同】的字，其余位置一个字都不要动。

规则：
- 姓保留不变。
- 只改指出来的那几个字，别的位置原样保留。
- 必须是【同音字】（拼音完全一样，声调也一样），不是形近字、不是近音字。
- 新字要是常见字，能当名字用。

只回：{"replacement":"改好的全名"}`
  const user = `原名：${original}\n当前改名：${replacement}\n没换掉的字：${stuck.join('、')}`
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'deepseek-chat', temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    }),
  })
  const j = await res.json()
  return JSON.parse(j.choices[0].message.content).replacement
}

/** 代码这边验：长度对不对、姓有没有动、指出的字换了没、是不是真同音 */
function verify (original, fixed) {
  const a = [...original], b = [...fixed]
  if (a.length !== b.length) return '长度变了'
  const stuck = unchangedGivenChars(original, fixed)
  if (stuck.length > 0) return `还有没换的：${stuck.join('')}`
  const py = (s) => pinyin(s, { toneType: 'num', type: 'array' })
  const pa = py(original), pb = py(fixed)
  const bad = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (pa[i] !== pb[i]) bad.push(`${a[i]}(${pa[i]})→${b[i]}(${pb[i]})`)
  }
  return bad.length > 0 ? `不同音：${bad.join('、')}` : null
}

const db = openUserDb('陈梓昂', ['陈梓昂', '黄诗婕'])
const p = db.listProjects().find((x) => x.name === '周周花心')
db.close()
console.log(`文案 ${p.scriptText.length} 字\n`)

const t0 = Date.now()
const a = await analyzeNovel(p.scriptText)
console.log(`整篇分析 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，${a.characters.length} 个人物`)

const v = findIdentityViolations(a)
console.log(`\n【没换干净的】${v.length} 处：`)
for (const x of v) console.log('  ', x)

console.log('\n── 逐个单独重试 ──')
for (const c of a.characters) {
  const stuck = unchangedGivenChars(c.original, c.replacement)
  if (stuck.length === 0 && c.replacement !== c.original) continue
  const t = Date.now()
  let fixed = await fixOne(c.original, c.replacement, stuck.length > 0 ? stuck : [...c.original].slice(1))
  const err = verify(c.original, fixed)
  console.log(`  ${c.original} → ${c.replacement}  ⇒  ${fixed}   ${((Date.now() - t) / 1000).toFixed(1)}s   ${err ?? '✓'}`)
}
