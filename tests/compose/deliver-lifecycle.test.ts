import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverTag, pendingDeliver, sweepDelivered } from '../../src/compose/deliver.js'
import type { DeliverInput } from '../../src/compose/deliver.js'

/**
 * 成片的生命周期。**这一组守的是用户定的那条规则**：
 *
 *   「没有下载的成片就一直保持好储存，直到下载了再清除。」
 *
 * 2026-08-13 线上违反过一次：为了让 BBR 生效重启服务，开机清扫把用户
 * 正在下载的那份 480MB 删了（review #13）。根因是成片文件名用随机串、
 * 不携带身份，重启后分辨不出"有用的"和"垃圾"，于是只能一律删。
 */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function makeDir (): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sj-deliver-'))
  dirs.push(d)
  await writeFile(join(d, 'master.json'),
    JSON.stringify({ fingerprint: 'MFP-1', status: 'done' }), 'utf-8')
  return d
}

function inputOf (dir: string, over: Partial<DeliverInput> = {}): DeliverInput {
  return {
    dir, voicePath: join(dir, 'voice.mp3'), voiceGain: 1,
    bgmPath: null, bgmVolume: 0.15, coverTitle: '标题',
    aspect: { name: '9:16', width: 1080, height: 1920 },
    ...over,
  }
}

describe('成片的身份（参数指纹）', () => {
  it('同样的参数永远算出同一个名字——这就是天然去重', async () => {
    const dir = await makeDir()
    expect(deliverTag(inputOf(dir))).toBe(deliverTag(inputOf(dir)))
  })

  it('音量变了指纹就变——否则用户会拿到旧音量的片子', async () => {
    const dir = await makeDir()
    const a = deliverTag(inputOf(dir))
    expect(deliverTag(inputOf(dir, { voiceGain: 1.5 }))).not.toBe(a)
    expect(deliverTag(inputOf(dir, { bgmVolume: 0.4 }))).not.toBe(a)
  })

  it('母带重烧了指纹也要变——画面都换了，旧成片当然作废', async () => {
    const dir = await makeDir()
    const a = deliverTag(inputOf(dir))
    await writeFile(join(dir, 'master.json'),
      JSON.stringify({ fingerprint: 'MFP-2', status: 'done' }), 'utf-8')
    expect(deliverTag(inputOf(dir))).not.toBe(a)
  })
})

describe('清扫：只删垃圾，绝不删用户还没取走的成品', () => {
  it('【核心】完整且对得上的成片必须留下来', async () => {
    const dir = await makeDir()
    const i = inputOf(dir)
    const tag = deliverTag(i)
    await writeFile(join(dir, `deliver-${tag}.mp4`), 'FILM', 'utf-8')

    await sweepDelivered([{ dir, keepTag: tag }])

    expect(pendingDeliver(i)).not.toBeNull()
    expect(await readdir(dir)).toContain(`deliver-${tag}.mp4`)
  })

  it('半成品和中间产物一律删', async () => {
    const dir = await makeDir()
    const tag = deliverTag(inputOf(dir))
    for (const f of [
      `deliver-${tag}.partial.mp4`, `deliver-${tag}.mixed.mp4`,
      `deliver-${tag}.cover.mp4`, 'mixed.mp4', 'export.mp4', 'cover.mp4',
    ]) await writeFile(join(dir, f), 'x', 'utf-8')

    const n = await sweepDelivered([{ dir, keepTag: tag }])

    expect(n).toBe(6)
    expect((await readdir(dir)).filter((f) => f !== 'master.json')).toEqual([])
  })

  it('指纹对不上的旧成片要清掉——参数已经变了，没人会要它', async () => {
    const dir = await makeDir()
    const tag = deliverTag(inputOf(dir))
    await writeFile(join(dir, 'deliver-deadbeef.mp4'), 'OLD', 'utf-8')
    await writeFile(join(dir, `deliver-${tag}.mp4`), 'NEW', 'utf-8')

    await sweepDelivered([{ dir, keepTag: tag }])

    const left = (await readdir(dir)).filter((f) => f.startsWith('deliver-'))
    expect(left).toEqual([`deliver-${tag}.mp4`])
  })

  /*
   * ⚠️ 这一条是【上次翻车的直接守卫】。算不出该留哪个的时候（母带还没合成、
   * 项目状态不全），宁可多留一份，也绝不能再把用户的东西删掉。
   */
  it('算不出该留哪个时，完整的成片一律保留', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'deliver-deadbeef.mp4'), 'FILM', 'utf-8')
    await writeFile(join(dir, 'deliver-deadbeef.partial.mp4'), 'x', 'utf-8')

    await sweepDelivered([{ dir, keepTag: null }])

    const left = (await readdir(dir)).filter((f) => f.startsWith('deliver-'))
    expect(left).toEqual(['deliver-deadbeef.mp4'])   // 半成品删了，成品留着
  })

  it('没有 TTL：放多久都不删', async () => {
    const dir = await makeDir()
    const tag = deliverTag(inputOf(dir))
    await writeFile(join(dir, `deliver-${tag}.mp4`), 'FILM', 'utf-8')

    // 扫十次，模拟服务反复重启
    for (let k = 0; k < 10; k++) await sweepDelivered([{ dir, keepTag: tag }])

    expect(await readdir(dir)).toContain(`deliver-${tag}.mp4`)
  })
})
