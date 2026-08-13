import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mixAudio } from './mix.js'
import { renderCoverClip, prependCover, probeAudio, COVER_IMAGE } from '../cover/cover.js'
import { FILM_MASTER_FILE } from './film.js'
import type { AspectPreset } from '../types.js'

const run = promisify(execFile)

/**
 * 【下载那一刻才把声音烧进去，给完就删】。
 *
 * ── 为什么这么做 ────────────────────────────────────────────────────
 * 用户的要求：界面里的视频永远只是画面，配音和音乐是独立的两条流，
 * 只有下载时才真的混成一个文件。
 *
 * 收益有三层，从小到大：
 *   · 省盘：实测一条两分钟的片子，master+mixed+export 三份 302MB，
 *     后两份几乎就是 master 加条音轨。
 *   · 调音量【零成本】：从前拖一下滑块就要重混一个 100MB 的文件（几秒 +
 *     一次全量磁盘写入），现在播放器改个增益就完事。
 *   · 不会拿到过期的成片：盘上根本不存成片，下载永远按【此刻】的设置现混。
 *
 * ── 为什么封面也在这儿拼 ────────────────────────────────────────────
 * 封面片段必须照抄正片的音频参数（采样率/声道，见 cover.ts 的 probeAudio），
 * 而合成阶段根本没有音频。所以封面天然属于"成品"这一侧。
 */

export interface DeliverInput {
  dir: string
  voicePath: string
  voiceGain: number
  bgmPath: string | null
  bgmVolume: number
  coverTitle: string
  aspect: AspectPreset
}

/**
 * 现混一份可下载的成片，返回临时文件路径。**调用方负责传完删掉**。
 *
 * 文件名带一个随机串：同一条片子可能被两个请求同时下载（手机 + 电脑），
 * 用固定名的话后开始的那次会把前一次正在传的文件覆盖掉。
 */
export async function deliverFilm (i: DeliverInput): Promise<string> {
  const master = join(i.dir, FILM_MASTER_FILE)
  if (!existsSync(master)) throw new Error('还没有画面，先合成')
  if (!existsSync(i.voicePath)) throw new Error('还没有配音')

  const tag = randomUUID().slice(0, 8)
  const mixed = join(i.dir, `deliver-${tag}.mixed.mp4`)
  const cover = join(i.dir, `deliver-${tag}.cover.mp4`)
  const out = join(i.dir, `deliver-${tag}.mp4`)

  try {
    // 1. 画面 + 两条音轨（-c:v copy，一帧都不重编码）
    await mixAudio({
      masterPath: master,
      voicePath: i.voicePath, voiceGain: i.voiceGain,
      bgmPath: i.bgmPath, bgmVolume: i.bgmVolume,
      outPath: mixed,
    })
    // 2. 封面照抄【混好之后】的音频参数——写死 44100/stereo 遇上 Azure 的
    //    24000/mono，concat 出来的后半段会没声音
    await renderCoverClip({
      imagePath: COVER_IMAGE, title: i.coverTitle, aspect: i.aspect,
      outPath: cover, audio: await probeAudio(mixed),
    })
    await prependCover({ coverPath: cover, filmPath: mixed, outPath: out })
    return out
  } finally {
    // 中间产物立刻清掉，不等下载结束——它们已经没用了
    await rm(mixed, { force: true }).catch(() => {})
    await rm(cover, { force: true }).catch(() => {})
  }
}

/** 传完了就删。永远不抛——删不掉顶多留个临时文件，不该让下载失败 */
export async function dropDelivered (path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {})
}

/** 现混出来的文件多大。给 Content-Length 用，不然下载进度永远是 0% */
export async function deliveredSize (path: string): Promise<number> {
  const { stdout } = await run('stat', ['-c', '%s', path])
  return Number(stdout.trim())
}

/**
 * 开机清扫遗留的现混临时文件。
 *
 * ⚠️【必须有这道兜底】。正常路径是"传完就删"（挂在流的 close 上），
 * 但进程被杀、断电、或者哪个边界情况没触发 close，文件就会留在盘上——
 * 一份 100MB，攒几次就把磁盘吃满，而磁盘满的症状是 502，
 * 和"下载"看着毫无关系（这个坑踩过一次，查了很久）。
 *
 * 开机扫一遍最省事：那时一定没有正在进行的下载，删了不会误伤。
 */
export async function sweepDelivered (
  dirs: string[],
  /**
   * 只删这么久没动过的。**开机扫传 0**（那时一定没有正在进行的下载）。
   *
   * ⚠️【运行中扫必须带它】。下载中断之后成片是【故意留着】的——留着才能
   * 续传，不用把几百 MB 整条重来（见 queue/routes.ts 的下载路由）。
   * 运行中无差别地扫，等于把用户正在续传的那份从他手里抽走。
   */
  olderThanMs = 0,
  now = Date.now(),
): Promise<number> {
  let n = 0
  for (const dir of dirs) {
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    /*
     * 【顺带清掉老架构留下的成片】。改成"下载时才混"之前，每条项目盘上都
     * 躺着 mixed.mp4 + export.mp4 + cover.mp4（一条两分钟的片子就 200MB），
     * 它们现在【一个都用不上了】。留着不只是占地方——playableMaster 要是
     * 哪天又去碰它们，预览就会在已经含配音的文件上再叠一条配音。
     */
    const dead = new Set(['mixed.mp4', 'export.mp4', 'cover.mp4'])
    for (const f of names) {
      if (dead.has(f)) {
        await rm(join(dir, f), { force: true }).catch(() => {})
        n++
        continue
      }
      if (!f.startsWith('deliver-')) continue
      if (olderThanMs > 0) {
        try {
          if (now - (await stat(join(dir, f))).mtimeMs < olderThanMs) continue
        } catch { continue }
      }
      await rm(join(dir, f), { force: true }).catch(() => {})
      n++
    }
  }
  return n
}
