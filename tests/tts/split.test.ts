import { describe, it, expect } from 'vitest'
import { splitScript } from '../../src/tts/split.js'
import { estimateAudioMs, maxCharsForMs } from '../../src/tts/azure.js'

const MAX_MS = 8 * 60 * 1000

const sentence = '他决定去买包子。'          // 8 字
const long = sentence.repeat(400)            // 3200 字，约 10.5 分钟

describe('splitScript', () => {
  it('短文案不切，原样单段返回', () => {
    expect(splitScript('他决定去买包子。')).toEqual(['他决定去买包子。'])
  })

  it('长文案切成多段', () => {
    expect(splitScript(long).length).toBeGreaterThanOrEqual(2)
  })

  it('切段不丢字、不重复——拼回去等于原文', () => {
    expect(splitScript(long).join('')).toBe(long)
  })

  it('每段都在预算内', () => {
    for (const c of splitScript(long)) {
      expect(estimateAudioMs(c.length)).toBeLessThanOrEqual(MAX_MS)
    }
  })

  it('只在句末标点后切，不在句子中间断开', () => {
    for (const c of splitScript(long)) {
      expect(c).toMatch(/[。！？；…\n]$/)
    }
  })

  it('单句超上限时硬切，不死循环', () => {
    const noPunct = '包'.repeat(5000)   // 完全没有标点，约 16 分钟
    const chunks = splitScript(noPunct)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('')).toBe(noPunct)
  })

  /*
   * 下面三条是原计划没写、复核时补的。
   */

  it('自定义 maxMs 生效——预算减半，段数应增加', () => {
    const few = splitScript(long, MAX_MS)
    const many = splitScript(long, MAX_MS / 2)
    expect(many.length).toBeGreaterThan(few.length)
  })

  it('空文案不崩溃', () => {
    expect(splitScript('')).toEqual([''])
  })

  /*
   * 边界：恰好卡在预算线上。这同时检验 estimateAudioMs 与 maxCharsForMs
   * 是否真的互为反函数——两处若各自抄了一份 196，这条会红。
   */
  it('恰好等于预算的文案不切', () => {
    const exact = '包'.repeat(maxCharsForMs(MAX_MS))
    expect(estimateAudioMs(exact.length)).toBeLessThanOrEqual(MAX_MS)
    expect(splitScript(exact, MAX_MS)).toEqual([exact])
  })
})
