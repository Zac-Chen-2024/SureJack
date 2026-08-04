/*
 * 把替换表【按界面上的样子】打印出来，跑真文本、真 API。
 * 用的是生产代码：analyzeNovel（后端）+ pairInconsistencies（前端那份校验）。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2]
}
import { analyzeNovel } from '/root/SureJack/src/rename/deepseek.ts'
import { pairInconsistencies, pairShouldChange } from '/root/SureJack/web/src/store/rename.ts'

const CASES = [
  ['同源小名 + 陷阱词', `
顾文渊站在廊下看着雪。「渊儿，进来吧。」母亲唤他。
小顾这个称呼是府里下人叫的。沈知微提灯过来：「阿渊，又站这儿。」
「微微，」他回头。她微微一笑，把灯递过去：「知微姐姐让我送的汤。」
下人私下叫她沈二姑娘，只有顾文渊叫她微微。后来渊儿这个称呼再没人叫过。
`],
  ['不同源乳名', `
江砚辞是江家嫡子，可祖母偏叫他阿宝。
「阿宝，过来。」祖母招手。江砚辞低头应了一声。
表妹温思言总跟在他后头，家里人都叫她囡囡。
「囡囡别闹。」江砚辞说。温思言撇嘴：「辞哥哥偏心。」
`],
  ['单字名 + 身份称谓', `
沈砚是新来的少爷。管家叫他砚少爷，母亲只叫砚儿。
桌上的砚台是他父亲留下的。「砚儿，别摸那个。」母亲说。
林晚是他的伴读，众人喊她晚丫头。沈砚叫她阿晚。
`],
]

for (const [label, text] of CASES) {
  console.log('\n══════ ' + label + ' ══════')
  const a = await analyzeNovel(text.trim())
  for (const c of a.characters) {
    console.log(`\n[${c.role}] ${c.original} → ${c.replacement}`)
    for (const [j, p] of c.pairs.entries()) {
      if (p.from === c.original) continue
      const bad = pairInconsistencies(c, j)
      const noop = p.to === p.from && pairShouldChange(c, j)
      const flag = noop ? '  ⚠ 没换'
        : bad.length > 0 ? '  ⚠ ' + bad.map(([ch, want, got]) => `「${ch}」→「${got}」，大名里是「${want}」`).join('；')
        : ''
      console.log(`    ${p.from} → ${p.to}   ${p.global ? '全局' : '限上下文'}${flag}`)
    }
  }
}
