import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointOf, CHECKPOINT_LABEL, NEXT_STEP } from '../../src/compose/checkpoint.js'

/*
 * 重试要从最近的 checkpoint 接着走，而不是把整条链从头再来
 * （10 分钟配音 + 十几分钟烧录，而失败的可能只是最后混一次音）。
 */
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ckpt-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const touch = async (name: string): Promise<void> => { await writeFile(join(dir, name), 'x') }

describe('盘上做到哪一步了', () => {
  it('什么都没有 → none', () => {
    expect(checkpointOf(dir, { ttsReady: false })).toBe('none')
  })

  /*
   * ⚠️ 配音这一步【必须同时看文件和库里的状态】。半路被杀的合成会留下
   * 一个长度不对的 voice.mp3（线上实测：该有 441 秒，只写了 26 秒），
   * 文件在、但词级时间戳没落库——那不算做完。
   */
  it('ttsState 没 ready 就不算配音做完，哪怕盘上有 voice.mp3', async () => {
    await touch('voice.mp3')
    expect(checkpointOf(dir, { ttsReady: false })).toBe('none')
  })

  it('配音 ready → voice', () => {
    expect(checkpointOf(dir, { ttsReady: true })).toBe('voice')
  })

  it('有背景轨 → bg-track', async () => {
    await touch('bg-track.mp4')
    expect(checkpointOf(dir, { ttsReady: true })).toBe('bg-track')
  })

  it('有母带 → master（背景轨在不在都一样，母带更远）', async () => {
    await touch('bg-track.mp4')
    await touch('master.mp4')
    expect(checkpointOf(dir, { ttsReady: true })).toBe('master')
  })

  it('有成片 → export', async () => {
    await touch('master.mp4')
    await touch('export.mp4')
    expect(checkpointOf(dir, { ttsReady: true })).toBe('export')
  })

  it('每一档都有给人看的名字和下一步', () => {
    for (const k of ['none', 'voice', 'bg-track', 'master', 'export'] as const) {
      expect(CHECKPOINT_LABEL[k]).toBeTruthy()
      expect(NEXT_STEP[k]).toBeTruthy()
    }
  })
})
