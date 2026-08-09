import { describe, it, expect } from 'vitest'
import { DownloadPrep } from '../../src/compose/download-queue.js'
import type { DeliverInput } from '../../src/compose/deliver.js'

/*
 * 线上真出过：成片改成"下载那一刻现混"之后，混音要几十秒，而那几十秒里
 * 界面毫无反馈——用户以为没点上，连点几下，【每一下各起一个 ffmpeg】，
 * 各写几百 MB 临时文件，磁盘被撑满，请求全部失败。
 * 而用户看到的症状只是"下载键点了没反应"。
 *
 * 这个文件守两件事：去重、和磁盘先看够不够。
 */

const INPUT: DeliverInput = {
  dir: '/tmp', voicePath: '/tmp/v.mp3', voiceGain: 1,
  bgmPath: null, bgmVolume: 0.15, coverTitle: '标题',
  aspect: { name: '9:16', width: 1080, height: 1920 },
}

describe('下载备货：去重', () => {
  it('【同一条项目点五下，只起一个 ffmpeg】', async () => {
    let runs = 0
    const prep = new DownloadPrep(async () => {
      runs++
      await new Promise((r) => setTimeout(r, 30))
      return '/tmp/out.mp4'
    })

    for (let i = 0; i < 5; i++) prep.request('p1', INPUT, 1000)
    await prep.wait('p1')

    /*
     * ⚠️ 这条断言的是 runs，不是 waiters。waiters 是个【代用指标】——
     * 就算真起了五个 ffmpeg，它照样是 5，测了等于没测。
     * 线上那次磁盘被撑爆，坏的正是 runs 这个数。
     */
    expect(runs).toBe(1)
    expect(prep.snapshot('p1')?.waiters).toBe(5)
  })

  it('不同项目各混各的', () => {
    const prep = new DownloadPrep(async () => '/tmp/o.mp4')
    prep.request('p1', INPUT, 1000)
    prep.request('p2', INPUT, 1000)
    expect(prep.snapshot('p1')?.waiters).toBe(1)
    expect(prep.snapshot('p2')?.waiters).toBe(1)
  })

  /*
   * 【取走即作废】：不作废的话，用户改完音量再下一次，拿到的还是上一份，
   * 而他要验的正是这次的改动。
   */
  it('取走之后记录就没了', async () => {
    const prep = new DownloadPrep(async () => '/tmp/o.mp4')
    prep.request('p1', INPUT, 1000)
    await prep.wait('p1')
    prep.drop('p1')
    expect(prep.snapshot('p1')).toBeNull()
  })

  it('改了设置 → 已备好的那份作废', async () => {
    const prep = new DownloadPrep(async () => '/tmp/o.mp4')
    prep.request('p1', INPUT, 1000)
    await prep.wait('p1')
    const e = prep.snapshot('p1')
    if (e) { e.state = 'ready'; e.path = '/tmp/x.mp4' }
    prep.invalidate('p1')
    expect(prep.snapshot('p1')).toBeNull()
  })
})

describe('下载备货：磁盘不够要明说', () => {
  /*
   * 不先看磁盘的话，ffmpeg 会一路写到 No space left 才失败——那时它已经
   * 占了几百 MB，而且报出来的错和"磁盘"两个字离得很远（线上表现是
   * "下载点了没反应"，查了很久才发现是盘满）。
   */
  it('母带太大、盘不够 → 状态 error 且原因里带「磁盘」', async () => {
    const prep = new DownloadPrep(async () => '/tmp/o.mp4')
    // 母带号称 100TB，怎么算都不够
    prep.request('big', INPUT, 100 * 1024 ** 4)
    const e = await prep.wait('big')
    expect(e?.state).toBe('error')
    expect(e?.error ?? '').toContain('磁盘')
  }, 20_000)
})
