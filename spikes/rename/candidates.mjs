/*
 * 实验二：代码查同音字候选 → 喂给模型挑。
 * 查表是代码的活（穷尽、确定），挑哪个好听是模型的活。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env','utf8').split('\n')) {
  const m=/^([A-Z_]+)=(.*)$/.exec(l.trim()); if(m) process.env[m[1]]=m[2]
}
import { pinyin } from 'pinyin-pro'

/** 常用字表：GB2312 一级字库那一段（3755 字），足够当名字用 */
const COMMON = []
for (let c = 0x4e00; c <= 0x9fa5; c++) COMMON.push(String.fromCodePoint(c))
const byTone = new Map(), byBase = new Map()
for (const ch of COMMON) {
  const t = pinyin(ch, { toneType: 'num', type: 'array' })[0]
  const b = pinyin(ch, { toneType: 'none', type: 'array' })[0]
  if (!byTone.has(t)) byTone.set(t, []); byTone.get(t).push(ch)
  if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(ch)
}

function candidates (ch) {
  const t = pinyin(ch, { toneType: 'num', type: 'array' })[0]
  const b = pinyin(ch, { toneType: 'none', type: 'array' })[0]
  return {
    同调: (byTone.get(t) ?? []).filter((x) => x !== ch),
    同音不同调: (byBase.get(b) ?? []).filter((x) => x !== ch && !(byTone.get(t) ?? []).includes(x)),
  }
}

const KEY = process.env.DEEPSEEK_API_KEY
async function pick (original, replacement, stuck) {
  const lists = stuck.map((ch) => {
    const c = candidates(ch)
    return `「${ch}」同调同音：${c.同调.join('') || '（没有）'}\n     同音不同调：${c.同音不同调.slice(0, 40).join('') || '（没有）'}`
  }).join('\n  ')
  const sys = `你是中文谐音改名器，只回 JSON。

用户给你一个原名、一版没改干净的新名，以及【每个没换的字的同音字候选】。
从候选里挑一个【能当名字、字形不怪】的替上去，其余位置一个字都不要动。

- 优先挑【同调同音】的；同调里实在没有能当名字的，才用【同音不同调】的。
- 【异体字、生僻字都可以用】：只要读音相同就行，字形常不常见不重要。
  能挑到常用字最好，挑不到就用生僻的——【换掉】比【好看】要紧。
- ⚠️【不许以"当前这版已经可以接受"为由保留原字】。那个字既然被指出来了，
  就是必须换。你唯一能保留它的理由是【候选里确实没有一个能当名字的常用字】。
- 候选里【一个能用的都没有】时，把 replacement 原样返回，并把 stuck 里写上那个字
  ——交给人来定，不要硬凑一个怪字。

只回：{"replacement":"新全名","stuck":["实在换不了的字"],"why":"一句话"}`
  const user = `原名：${original}\n当前：${replacement}\n没换的字：\n  ${lists}`
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  })
  return JSON.parse((await res.json()).choices[0].message.content)
}

for (const [orig, repl, stuck] of [
  ['江崇桉', '江崇安', ['崇']],
  ['顾文渊', '顾文远', ['文']],
  ['沈知微', '沈知薇', ['知']],
]) {
  const c = candidates(stuck[0])
  console.log(`\n${orig} → ${repl}   「${stuck[0]}」同调 ${c.同调.length} 个 / 同音不同调 ${c.同音不同调.length} 个`)
  const r = await pick(orig, repl, stuck)
  console.log(`   ⇒ ${r.replacement}   stuck=${JSON.stringify(r.stuck ?? [])}   ${r.why ?? ''}`)
}
