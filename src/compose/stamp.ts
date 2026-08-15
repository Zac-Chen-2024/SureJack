/**
 * 产物的【指纹旁挂文件】。
 *
 * 背景轨（bg-track.json）先有的这套做法，成片（export.json）沿用它——
 * **不另造一套**。一个产物 + 一个 JSON，JSON 里记着"这份产物是按什么
 * 输入做出来的"。输入变了指纹就对不上，对不上就重做。
 *
 * ── 为什么不加 DB 列 ────────────────────────────────────────────────
 * 线上库要迁移，而这就是一行元数据；而且它必须和产物文件同生共死——
 * 删了目录就该一起没有，DB 做不到这一点。
 *
 * ── 为什么带 status ─────────────────────────────────────────────────
 * 光有 fingerprint 只能回答"能不能复用"。成片还要回答两个问题：
 * 「正在做吗」和「上次为什么没做成」，而这两个答案必须**活过进程重启**
 * ——否则服务一重启，一条失败的成片就变回"没做过"，然后被自动重排，
 * 一条必然失败的任务无限重跑，机器就这么被占死了。
 *
 * status 缺省视为 done：老的 bg-track.json 只写了 fingerprint 一个字段，
 * 那些文件现在还躺在 data/ 里，不能因为多了个字段就全作废重拼。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type StampStatus = 'building' | 'done' | 'error' | 'cancelled'

export interface Stamp {
  fingerprint: string
  /** 缺省 = done（兼容只有 fingerprint 的老文件） */
  status?: StampStatus
  /** status=error 时的原因，直接给用户看 */
  error?: string
  /** 做这份产物的作业 id，用来问队列"还在跑吗" */
  jobId?: string
  /**
   * status=error 时的【错误码】，形如 E-3f9a21（作业 id 前 6 位）。
   * 用户把它念给开发者，开发者拿它 grep 日志——比"我点了下然后转圈"有用。
   */
  code?: string
  /**
   * 母带烧成后被回收的背景轨:字节数 + 它当时的 mtime。
   *
   * 记 mtime 是为了【留下"这一次到底有没有重拼背景轨"的证据】。背景轨在
   * 母带烧成后就被删了(它 385MB，纯中间产物)，删掉之后就再也无法通过
   * 文件本身证明"导出复用了预拼的那条、没有白拼一遍"——而那恰恰是
   * 预拼这个优化存在的唯一理由。把 mtime 留在指纹里，测试和排查都还能对得上。
   */
  bgFreed?: { bytes: number, mtimeMs: number }
  /**
   * ── 以下四项只出现在【母带】的旁挂文件里,为「重选开头」服务 ──────
   *
   * 有了它们,重选开头时才能回答"盘上这条母带的后半段能不能原样拿来拼"。
   * 缺任何一项都当成"不能",退回整条重烧——这条路慢十几分钟,但永远正确。
   */
  /** 开头段在哪一毫秒结束 */
  boundaryMs?: number
  /** 开头那一段的指纹:换开头素材它就变 */
  headFingerprint?: string
  /** 后半段的指纹:**只要它没变,后半段就能复用** */
  tailFingerprint?: string
  /**
   * ⚠️【这一条烧的时候真的传了 `-force_key_frames`】。
   * 不是推断出来的:加这个功能之前烧的母带在分界处没有关键帧,而分界
   * 照样算得出来。没有这一帧就 `-c copy`,切出来的后半段前几帧是花的。
   */
  keyframeForced?: true
}

export async function writeStamp (dir: string, file: string, stamp: Stamp): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), JSON.stringify(stamp), 'utf-8')
}

/**
 * 读指纹。⚠️【永远不抛】——一个读不出来的旁挂文件不该让用户导不出片子，
 * 读不出来就当"没做过"，大不了重做一遍。
 */
export async function readStamp (dir: string, file: string): Promise<Stamp | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, file), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec: Record<string, unknown> = { ...parsed }
    const { fingerprint, status, error, jobId } = rec
    const { boundaryMs, headFingerprint, tailFingerprint, keyframeForced } = rec
    if (typeof fingerprint !== 'string') return null
    /*
     * 认不出来的 status 一律丢掉而不是保留。丢掉会退化成 "缺省 = done"，
     * 那是个**可验证**的判断（后面还要 stat 文件、比指纹）；而保留一个
     * 谁也不认识的字符串，只会让下游多一条没人测过的分支。
     */
    const known = status === 'building' || status === 'done' || status === 'error' || status === 'cancelled'
    return {
      fingerprint,
      ...(known ? { status } : {}),
      ...(typeof error === 'string' ? { error } : {}),
      ...(typeof jobId === 'string' ? { jobId } : {}),
      /*
       * 拆分那四项【要么整组都在,要么当作没有】。少一项就去切,切法和
       * 判据就对不上了;而"当作没有"的后果只是整条重烧——慢,但永远正确。
       */
      ...(typeof boundaryMs === 'number' && boundaryMs > 0
        && typeof headFingerprint === 'string' && typeof tailFingerprint === 'string'
        && keyframeForced === true
        ? { boundaryMs, headFingerprint, tailFingerprint, keyframeForced: true as const }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * 盘上现成的产物还能不能用。能用给路径，不能用给 null。⚠️ 永远不抛。
 *
 * 0 字节要当成不可用：做到一半被杀会留下半个 mp4，而半个 mp4 的
 * `size > 0` 判断不出来——这里连同"完全空"一起挡掉，剩下的靠
 * **先有完整文件、再写 done 指纹**这个写入顺序保证。
 */
export async function reusableOutput (
  dir: string, stampFile: string, outFile: string, fingerprint: string,
): Promise<string | null> {
  const stamp = await readStamp(dir, stampFile)
  if (stamp === null || stamp.fingerprint !== fingerprint) return null
  if (stamp.status !== undefined && stamp.status !== 'done') return null
  try {
    const path = join(dir, outFile)
    if ((await stat(path)).size <= 0) return null
    return path
  } catch {
    return null
  }
}
