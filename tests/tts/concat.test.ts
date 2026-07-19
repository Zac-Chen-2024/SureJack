import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { concatAudio } from '../../src/tts/concat.js'
import { probeDurationMs } from '../../src/render/probe.js'

const run = promisify(execFile)

/** 用 ffmpeg 生成一段指定秒数的静音 mp3 */
async function silence (path: string, seconds: number) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    `anullsrc=r=24000:cl=mono`, '-t', String(seconds), path])
}

describe('concatAudio', () => {
  it('拼接后的时长约等于各段之和', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat-'))
    try {
      const a = join(dir, 'a.mp3'), b = join(dir, 'b.mp3'), out = join(dir, 'out.mp3')
      await silence(a, 2); await silence(b, 3)

      await concatAudio([a, b], out)

      // 容差 300ms：mp3 帧对齐会有零头
      expect(await probeDurationMs(out)).toBeGreaterThan(4700)
      expect(await probeDurationMs(out)).toBeLessThan(5300)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('单段输入也能正常处理', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat1-'))
    try {
      const a = join(dir, 'a.mp3'), out = join(dir, 'out.mp3')
      await silence(a, 2)
      await concatAudio([a], out)
      expect(await probeDurationMs(out)).toBeGreaterThan(1700)
      expect(await probeDurationMs(out)).toBeLessThan(2300)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  /*
   * 这不是假想的边界：用户素材里真实存在 剪素材n'n.mp4。
   * concat 清单用单引号包路径，不转义就会被解析错。
   */
  it('路径含单引号时不被 concat 清单语法破坏', async () => {
    const dir = await mkdtemp(join(tmpdir(), "con'cat-"))
    try {
      const a = join(dir, "a'1.mp3"), out = join(dir, 'out.mp3')
      await silence(a, 1)
      await concatAudio([a], out)
      expect(await probeDurationMs(out)).toBeGreaterThan(500)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('输入为空时抛出可读的错误', async () => {
    await expect(concatAudio([], '/tmp/x.mp3')).rejects.toThrow(/输入为空/)
  })

  /*
   * outPath 位于用户的素材目录，是要展示给用户看的。concat 清单若写在
   * 那里，进程被 SIGKILL 时 finally 来不及执行，就会留下孤儿 .txt。
   * 所以清单必须落在系统临时目录——这条测试卡住这个约束。
   */
  it('产物目录里只有成片，不留任何中间文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat-clean-'))
    try {
      const a = join(dir, 'a.mp3'), b = join(dir, 'b.mp3')
      await silence(a, 1); await silence(b, 1)

      const outDir = await mkdtemp(join(tmpdir(), 'concat-out-'))
      await concatAudio([a, b], join(outDir, 'out.mp3'))

      expect(await readdir(outDir)).toEqual(['out.mp3'])
      await rm(outDir, { recursive: true, force: true })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
