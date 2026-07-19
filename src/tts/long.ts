import type { WordTiming } from '../types.js'

/**
 * 把一段的词时间轴整体平移 offsetMs。
 *
 * 【只动 offsetMs】：durationMs 是这个词自身念了多久，与它在总时间轴上
 * 的位置无关，平移时绝不能动。
 *
 * 返回新数组，不就地修改——调用方可能还要用原始的段内时间轴排查问题。
 */
export function shiftWords (words: WordTiming[], offsetMs: number): WordTiming[] {
  return words.map((w) => ({ ...w, offsetMs: w.offsetMs + offsetMs }))
}
