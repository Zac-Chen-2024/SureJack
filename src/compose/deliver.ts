import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mixAudio } from './mix.js'
import { renderCoverClip, prependCover, probeAudio, COVER_IMAGE } from '../cover/cover.js'
import { FILM_MASTER_FILE, MASTER_STAMP_FILE } from './film.js'
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
 * 【成片的身份】= 母带指纹 + 这一份用的音频参数。
 *
 * ── 为什么必须让文件名携带身份 ──────────────────────────────────────
 * 原来用 randomUUID 起名，于是文件【不携带任何信息】——光看盘上一个
 * `deliver-*.mp4`，判断不出它属于哪套参数、是否完整、还有没有人要。
 * 唯一知道这些的是内存里的 DownloadPrep，而进程一重启就没了。
 *
 * 既然重启后分辨不出"有用的"和"垃圾"，开机清扫只能【一律删掉】——
 * 2026-08-13 18:12 就是这么把用户正在下载的那份 480MB 删掉的：
 * 当时为了让 BBR 生效重启了一次服务，清扫顺手就把它清了。
 * 注释里写着"开机时一定没有正在进行的下载"，而那句话在【主动重启】时是错的。
 *
 * 换成指纹之后，一个改动同时解决四件事：
 *   · 重启后认得出来——算一遍指纹对得上，就是有效的待取成片，直接接管
 *   · 参数变了自然过期——对不上就是旧的，可以明确清理
 *   · 半成品一眼可辨——见下面 .partial 的说明
 *   · 天然去重——同一条片子同样的参数，永远是同一个文件名
 *
 * ⚠️ 母带指纹从 master.json 读。归档【故意保留】这个文件（才 145 字节），
 * 就是为了让已归档项目的待取成片仍然算得出指纹。
 */
export function deliverTag (i: DeliverInput): string {
  let masterFp = ''
  try {
    const raw = readFileSync(join(i.dir, MASTER_STAMP_FILE), 'utf8')
    masterFp = String((JSON.parse(raw) as { fingerprint?: unknown }).fingerprint ?? '')
  } catch { /* 没有指纹文件就只按音频参数算，下面照样能对上 */ }
  const key = [
    masterFp, i.voicePath, i.voiceGain,
    i.bgmPath ?? '', i.bgmVolume, i.coverTitle, i.aspect,
  ].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/** 完整的待取成片长这样。**别的以 deliver- 开头的一律是垃圾** */
const COMPLETE_RE = /^deliver-[0-9a-f]{8}\.mp4$/

/** 这一套参数对应的成片已经混好了吗。混好了给路径，没有给 null */
export function pendingDeliver (i: DeliverInput): string | null {
  const p = join(i.dir, `deliver-${deliverTag(i)}.mp4`)
  return existsSync(p) ? p : null
}

/**
 * 现混一份可下载的成片。**调用方负责在下载真正完成后删掉**。
 *
 * 已经有一份对得上的就直接返回，不重混。
 */
export async function deliverFilm (i: DeliverInput): Promise<string> {
  const ready = pendingDeliver(i)
  if (ready !== null) return ready

  const master = join(i.dir, FILM_MASTER_FILE)
  if (!existsSync(master)) throw new Error('还没有画面，先合成')
  if (!existsSync(i.voicePath)) throw new Error('还没有配音')

  const tag = deliverTag(i)
  const mixed = join(i.dir, `deliver-${tag}.mixed.mp4`)
  const cover = join(i.dir, `deliver-${tag}.cover.mp4`)
  /*
   * 【先写 .partial，完成后 rename】。rename 在同一个文件系统上是原子的，
   * 所以【只要 deliver-<fp>.mp4 存在，它就一定是完整的】——
   * 开机清扫据此分辨垃圾和成品，不用去猜。
   */
  const partial = join(i.dir, `deliver-${tag}.partial.mp4`)
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
    await prependCover({ coverPath: cover, filmPath: mixed, outPath: partial })
    await rename(partial, out)      // ← 原子：这一刻起它才算"完整的待取成片"
    return out
  } finally {
    // 中间产物立刻清掉，不等下载结束——它们已经没用了
    await rm(mixed, { force: true }).catch(() => {})
    await rm(cover, { force: true }).catch(() => {})
    await rm(partial, { force: true }).catch(() => {})   // 失败时留下的半成品
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
 * 清扫成片目录。**只删垃圾，绝不删完整的待取成片。**
 *
 * ── 规则 ────────────────────────────────────────────────────────────
 *   删：`deliver-*.partial.mp4` / `.mixed.mp4` / `.cover.mp4`（半成品和中间产物）
 *   删：老架构留下的 mixed.mp4 / export.mp4 / cover.mp4
 *   删：完整但【指纹对不上】的成片（参数已经变了，没人会要它）
 *   留：完整且指纹对得上的 —— 那是用户还没取走的成品
 *
 * ⚠️【这是用户定的规则】："没有下载的成片就一直保持好储存，直到下载了再清除。"
 * 所以这里【没有 TTL】。原来那条"6 小时没人取就删"和这条规则直接冲突，
 * 已经去掉——磁盘紧张时由 disk-guard 通过【提前归档】来腾，
 * 而不是把用户还没拿到手的东西删掉。
 *
 * ⚠️ 原来的开机清扫是【无差别删光】，理由是"开机时一定没有正在进行的下载"。
 * 那句话在【主动重启服务】时是错的，线上因此丢过一份 480MB（review #13）。
 *
 * @param entries 每条项目的目录 + 【要保留的指纹】。指纹算不出来（比如母带
 *                还没合成）就传 null，此时该目录下的完整成片一律保留——
 *                宁可多留一份，也不能再误删用户的东西。
 */
export async function sweepDelivered (
  entries: Array<{ dir: string, keepTag: string | null }>,
): Promise<number> {
  let n = 0
  for (const { dir, keepTag } of entries) {
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
      if (COMPLETE_RE.test(f)) {
        // 完整的：只有在【明确知道该留哪个】且这个不是它时才删
        if (keepTag !== null && f !== `deliver-${keepTag}.mp4`) {
          await rm(join(dir, f), { force: true }).catch(() => {})
          n++
        }
        continue
      }
      // 剩下的都是半成品和中间产物，一律删
      await rm(join(dir, f), { force: true }).catch(() => {})
      n++
    }
  }
  return n
}
