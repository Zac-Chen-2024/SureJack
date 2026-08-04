/*
 * 小名识别实验台（不碰生产代码）。
 *
 * 问题：同一个人在正文里会有好几个叫法——大名「顾文渊」、小名「渊儿」、
 * 昵称「阿渊」、加姓的「小顾」。现在的提示词只要"人名 → 谐音名"的映射，
 * 没说这些变体要和大名【保持一致】。结果可能是：
 *   顾文渊 → 顾闻缘，但 渊儿 → 원儿/没换/换成别的音
 * 观众会以为是两个人。
 *
 * 这个台子只做一件事：拿现在【生产用的那份提示词】跑一段带小名的文本，
 * 看它到底怎么处理，再决定提示词怎么改。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2]
}
import { analyzeNovel } from '/root/SureJack/src/rename/deepseek.ts'

const TEXT = `
顾文渊站在廊下，看着院子里的雪。
「渊儿，进来吧，外头冷。」母亲在屋里唤他。
他没动。小顾这个称呼是府里下人叫的，他不喜欢。
沈知微提着灯笼从月洞门那边过来，「阿渊，你又在这儿站着。」
「微微，」他终于回头，「你怎么来了。」
沈知微把灯笼递给他：「知微姐姐让我给你送的汤。」
下人们私下里都叫她沈二姑娘，只有顾文渊叫她微微。
后来顾文渊病重，渊儿这个称呼再没人叫过。
沈知微守在床边，一遍遍地喊阿渊。
`.trim()

const a = await analyzeNovel(TEXT)
console.log('识别到', a.characters.length, '个人名：\n')
for (const c of a.characters) {
  console.log(`  ${c.original}  →  ${c.replacement}` + (c.role ? `   (${c.role})` : ''))
  for (const p of c.pairs ?? []) {
    console.log(`        ${p.from} → ${p.to}   ${p.global ? '全局' : '限上下文:' + JSON.stringify(p.contexts ?? [])}`)
  }
}
console.log('\n关系：')
for (const r of a.relationships ?? []) console.log(' ', JSON.stringify(r))
