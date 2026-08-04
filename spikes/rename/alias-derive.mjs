/*
 * 实验二：别名的替换能不能【算出来】，而不是让模型再翻译一遍。
 *
 * 思路：大名的映射本身就是一份逐字对照表——
 *   顾文渊 → 顾闻远   ⇒  文→闻、渊→远（姓「顾」不动）
 * 那么任何含这些字的别名都能直接推：渊儿→远儿、阿渊→阿远、微微→薇薇。
 *
 * 这样模型只需要【找出别名】（它擅长），翻译交给代码（确定性、可验证）。
 * 和这个项目一贯的纪律一致：LLM 出指令，代码执行。
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/SureJack/.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2]
}

/** 从「大名 → 新名」推出逐字映射。长度不同就放弃（谐音替换本来就是等长的） */
function charMap (original, replacement) {
  const a = [...original], b = [...replacement]
  if (a.length !== b.length) return null
  const m = new Map()
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) m.set(a[i], b[i])
  return m
}

/** 用逐字映射翻译一个别名。没有一个字命中就返回 null（说明它和这个人无关） */
function deriveAlias (alias, m) {
  let hit = false
  const out = [...alias].map((c) => {
    const to = m.get(c)
    if (to !== undefined) { hit = true; return to }
    return c
  }).join('')
  return hit ? out : null
}

const CASES = [
  ['顾文渊', '顾闻远', ['渊儿', '阿渊', '小顾', '文渊哥哥', '顾公子']],
  ['沈知微', '沈芷薇', ['微微', '知微姐姐', '沈二姑娘', '阿微']],
  ['周雨桐', '周宇彤', ['桐桐', '小桐', '雨桐']],
]

for (const [orig, repl, aliases] of CASES) {
  const m = charMap(orig, repl)
  console.log(`${orig} → ${repl}   逐字映射: ${[...m].map(([a, b]) => a + '→' + b).join(' ')}`)
  for (const al of aliases) {
    const got = deriveAlias(al, m)
    console.log(`   ${al.padEnd(6)} → ${got ?? '（不含名字，保持原样）'}`)
  }
  console.log()
}
