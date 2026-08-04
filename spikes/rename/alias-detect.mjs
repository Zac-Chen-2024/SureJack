/*
 * 实验三：让模型【只找别名】，看它找得全不全、准不准。
 * 翻译不问它（实验二已证明能算出来）。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2]
}

const TEXT = `
顾文渊站在廊下，看着院子里的雪。
「渊儿，进来吧，外头冷。」母亲在屋里唤他。
他没动。小顾这个称呼是府里下人叫的，他不喜欢。
沈知微提着灯笼从月洞门那边过来，「阿渊，你又在这儿站着。」
「微微，」他终于回头，「你怎么来了。」
她微微一笑，把灯笼递给他：「知微姐姐让我给你送的汤。」
下人们私下里都叫她沈二姑娘，只有顾文渊叫她微微。
后来顾文渊病重，渊儿这个称呼再没人叫过。
沈知微守在床边，一遍遍地喊阿渊。
`.trim()

const SYSTEM = `你是中文小说的人名分析器。

找出正文里出现的【所有人物】，以及每个人物的【所有称呼变体】。

变体包括：小名（渊儿）、昵称（阿渊、微微）、带姓的简称（小顾）、
带称谓的（知微姐姐、沈二姑娘）、单独出现的名（文渊）。

⚠️ 只收【确实用来称呼这个人】的字符串。像「微微一笑」里的"微微"是副词，
不是称呼，不要收。拿不准就不收——收错了会把正文里的普通词也改掉。

只回 JSON：
{"people":[{"name":"大名","aliases":["别名1","别名2"],"role":"男主/女主/配角"}]}`

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: TEXT }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  }),
})
const data = await res.json()
const out = JSON.parse(data.choices[0].message.content)
for (const p of out.people ?? []) {
  console.log(`${p.name}（${p.role ?? '?'}）`)
  console.log('   别名:', (p.aliases ?? []).join('  ') || '（无）')
}

// 对照：文本里【真实存在】的称呼
console.log('\n人工标注的答案：')
console.log('  顾文渊: 渊儿 / 阿渊 / 小顾')
console.log('  沈知微: 微微 / 知微姐姐 / 沈二姑娘')
console.log('  陷阱:  「微微一笑」的微微不是称呼')
