import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { probeDurationMs } from '../../src/render/probe.js'

const run = promisify(execFile)

/*
 * 样本【现场生成】，不引用 Material/ 或 spikes/ 下的文件。
 *
 * 那些目录都被 .gitignore 挡着，只存在于开发者本机——测试引用它们的话，
 * 别人克隆这个仓库跑 npm test 就是红的，而在本机上永远发现不了。
 * 这个问题正是子代理在干净的 git worktree 里跑测试时暴露出来的。
 */
let dir: string
let audio: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'probe-test-'))
  audio = join(dir, 'sample.mp3')
  // 精确 3 秒的静音
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
    '-t', '3', audio])
})

afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('probeDurationMs', () => {
  it('探测真实音频文件时长', async () => {
    const ms = await probeDurationMs(audio)
    // 容差 100ms：mp3 帧对齐会有零头
    expect(ms).toBeGreaterThan(3000 - 100)
    expect(ms).toBeLessThan(3000 + 100)
  })

  it('探测不存在的文件 → 抛错', async () => {
    await expect(probeDurationMs(join(dir, '不存在.mp3'))).rejects.toThrow()
  })
})
