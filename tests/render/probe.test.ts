import { describe, it, expect } from 'vitest'
import { probeDurationMs } from '../../src/render/probe.js'

describe('probeDurationMs', () => {
  it('探测真实音频文件时长（约 687312ms，允许 ±100ms）', async () => {
    const ms = await probeDurationMs('Material/Text/军师.mp3')
    expect(ms).toBeGreaterThan(687312 - 100)
    expect(ms).toBeLessThan(687312 + 100)
  })

  it('探测不存在的文件 → 抛错', async () => {
    await expect(probeDurationMs('Material/Text/不存在.mp3')).rejects.toThrow()
  })
})
