import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitScript } from '../../src/tts/split.js'

// 8 分钟 ≈ 480000ms ÷ 196ms/字 ≈ 2449 字
const sentence = '他决定去买包子。'          // 8 字
const long = sentence.repeat(400)            // 3200 字，约 10.5 分钟

test('短文案不切，原样单段返回', () => {
  assert.deepEqual(splitScript('他决定去买包子。'), ['他决定去买包子。'])
})

test('长文案切成多段', () => {
  const chunks = splitScript(long)
  assert.ok(chunks.length >= 2, `应该切成多段，实际 ${chunks.length} 段`)
})

test('切段不丢字、不重复——拼回去等于原文', () => {
  assert.equal(splitScript(long).join(''), long)
})

test('每段都在预算内', () => {
  for (const c of splitScript(long)) {
    assert.ok(c.length * 196 <= 8 * 60 * 1000, `有段超预算：${c.length} 字`)
  }
})

test('只在句末标点后切，不在句子中间断开', () => {
  for (const c of splitScript(long)) {
    assert.match(c, /[。！？；…\n]$/, `段尾不是句末标点：${c.slice(-10)}`)
  }
})

test('单句超上限时硬切，不死循环', () => {
  const noPunct = '包'.repeat(5000)   // 完全没有标点，约 16 分钟
  const chunks = splitScript(noPunct)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks.join(''), noPunct)
})
