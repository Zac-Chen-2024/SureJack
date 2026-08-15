import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPreview, hasPreview, previewDir, PREVIEW_PLAYLIST } from '../../src/compose/preview.js'

const run = promisify(execFile)

/*
 * 母带实测 7.5 Mbps（13 分钟 726MB），而跨洲可用带宽常常只有 2–5 Mbps——
 * 播放速度追不上片子的码率，用户在国外看预览一直转圈。
 * 预览是 540×960 / 约 1 Mbps 的 HLS 分段：实测 727MB → 94MB，小 7.8 倍。
 */
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'prev-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function makeMaster (seconds: number): Promise<string> {
  const p = join(dir, 'master.mp4')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=1080x1920:r=30`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', '-t', String(seconds), p])
  return p
}

describe('预览分段', () => {
  it('生成索引 + 分段，而且比母带小得多', async () => {
    const master = await makeMaster(12)
    await buildPreview(dir, master)

    expect(hasPreview(dir)).toBe(true)
    const files = await readdir(previewDir(dir))
    const segs = files.filter((f) => f.endsWith('.ts'))
    expect(segs.length).toBeGreaterThan(1)          // 12 秒 / 6 秒一段 → 至少两段

    const m3u8 = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')
    expect(m3u8).toContain('#EXTM3U')
    expect(m3u8).toContain('seg-0000.ts')
    // VOD：播放器知道这是完整的一条，可以直接跳到任意位置
    expect(m3u8).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
  }, 120_000)

  /*
   * ⚠️【并发去重不是优化，是必须】。烧录完成后会在后台生成一份，而用户可能
   * 同时点开预览也触发一次——两个 ffmpeg 会互相清空对方的目录
   * （第一步就是 rm -rf），结果两边都产出残缺的分段，而索引看起来是好的。
   */
  it('同时叫两次，只做一次，而且结果是完整的', async () => {
    const master = await makeMaster(12)
    await Promise.all([
      buildPreview(dir, master),
      buildPreview(dir, master),
    ])
    const files = await readdir(previewDir(dir))
    const segs = files.filter((f) => f.endsWith('.ts'))
    // 段号必须是连续的 0,1,2...：互相清目录的话中间会缺号
    const nums = segs.map((f) => Number(/seg-(\d+)\.ts/.exec(f)?.[1])).sort((a, b) => a - b)
    expect(nums).toEqual(nums.map((_, i) => i))
  }, 120_000)

  it('已经有了就不重做', async () => {
    const master = await makeMaster(6)
    await buildPreview(dir, master)
    const before = (await readdir(previewDir(dir))).length
    await buildPreview(dir, master)          // 第二次
    expect((await readdir(previewDir(dir))).length).toBe(before)
  }, 120_000)

  it('母带不在就明说，不是悄悄产出一个空目录', async () => {
    await expect(buildPreview(dir, join(dir, '不存在.mp4'))).rejects.toThrow('母带')
  })
})

describe('分段挂内容版本号', () => {
  /*
   * ⚠️ 这一组是【线上真踩的 bug】钉成的回归测试。
   *
   * 分段名是【按位置】的：seg-0000.ts 永远叫这个名字，而母带一重烧，
   * 同一个 URL back 的就是不同的字节。而分段是按 immutable 长缓存发出去的
   * ——浏览器根本不会再问服务器。
   *
   * 症状：重选开头之后，下载下来是对的、封面是对的，唯独预览里开头没变。
   * 因为换头只改了第一个分段的字节，后面几十个分段本来就一样，
   * 缓存里那份旧的 seg-0000.ts 就是唯一错的东西。
   */
  it('索引里每个分段都带 ?v=<内容哈希>', async () => {
    const master = await makeMaster(12)
    await buildPreview(dir, master)
    const m3u8 = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')
    const segLines = m3u8.split('\n').filter((l) => l.trim().startsWith('seg-'))
    expect(segLines.length).toBeGreaterThan(1)
    for (const l of segLines) expect(l.trim()).toMatch(/^seg-\d{4}\.ts\?v=[0-9a-f]{8}$/)
  }, 120_000)

  /*
   * 【内容变了版本号才变】。按母带指纹挂一个整份的版本号一行就能写完，
   * 但那样每个分段都会失效——9 分半的片子预览约 70MB，而她那条跨洲的线
   * 只有几百 KB/s。按内容算，换开头只有第一个分段变。
   */
  it('同样的内容 → 同样的版本号（不会平白让缓存失效）', async () => {
    const master = await makeMaster(12)
    await buildPreview(dir, master)
    const a = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')
    await buildPreview(dir, master, { force: true })   // 原样重做一遍
    const b = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')
    expect(b).toBe(a)
  }, 180_000)

  it('内容变了 → 版本号跟着变', async () => {
    const master = await makeMaster(12)
    await buildPreview(dir, master)
    const before = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')

    // 换一条画面完全不同的母带，重做预览
    const other = join(dir, 'other.mp4')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'smptebars=d=12:s=1080x1920:r=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-t', '12', other])
    await buildPreview(dir, other, { force: true })
    const after = await readFile(join(previewDir(dir), PREVIEW_PLAYLIST), 'utf8')

    const v = (m: string): string[] => [...m.matchAll(/\?v=([0-9a-f]{8})/g)].map((x) => x[1]!)
    expect(v(after)[0]).not.toBe(v(before)[0])
  }, 180_000)
})
