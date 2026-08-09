import { statfs } from 'node:fs/promises'
import { deliverFilm, type DeliverInput } from './deliver.js'

/**
 * 下载的"备货"队列：现混一份成片，混好了放在那儿等客户端来取。
 *
 * ── 为什么要这一层 ──────────────────────────────────────────────────
 * 成片改成"下载那一刻才现混"之后，下载链接直接就是一次几十秒的混音。
 * 线上立刻出事：
 *   · 混音期间界面【毫无反馈】，用户以为没点上，于是连点几下；
 *   · 每一下都【各起一个 ffmpeg】，各写几百 MB 临时文件；
 *   · 磁盘被撑满，ffmpeg 报 No space left，请求全部失败——
 *     而用户看到的症状只是"下载键点了没反应"。
 *
 * 所以这一层管三件事：**去重**、**磁盘先看够不够**、**进度可查**。
 *
 * ── 去重是重点 ──────────────────────────────────────────────────────
 * 同一条项目重复点，全部并到【同一个任务】上。不是"忽略后面的点击"——
 * 后来的点击一样要拿到结果，只是不该再起一个 ffmpeg。
 */

/** 一份现混成片大约要几倍于母带的临时空间：混音一份 + 拼封面一份 */
const SPACE_FACTOR = 2.5
/** 再留这么多余量。磁盘刚好卡满时，别的功能（配音、烧录）会跟着一起坏 */
const SPACE_HEADROOM = 1024 * 1024 * 1024

export type PrepState = 'mixing' | 'ready' | 'error'

export interface PrepEntry {
  projectId: string
  state: PrepState
  /** 混好的文件。state=ready 才有 */
  path: string | null
  error: string | null
  /** 有几个人在等这一份。归零且已取走才好删 */
  waiters: number
  startedAt: number
}

/** 盘上还剩多少字节 */
export async function freeBytes (path: string): Promise<number> {
  const s = await statfs(path)
  return s.bavail * s.bsize
}

/**
 * 现混一份成片，够用就复用。
 *
 * ⚠️【同一条项目只跑一个】。这是这个模块存在的首要理由：不去重的话，
 * 用户多点几下就是几个 ffmpeg 同时写几百 MB，把盘撑爆。
 */
export class DownloadPrep {
  private readonly entries = new Map<string, PrepEntry>()
  private readonly work = new Map<string, Promise<void>>()

  /**
   * 真正干活的那个函数。做成可注入是为了能【真的验证"只混了一次"】——
   * 不注入的话测试只能断言"有几个人在等"，那是个代用指标：
   * 就算真起了五个 ffmpeg，它照样是 5，测了等于没测。
   */
  constructor (private readonly deliver: (i: DeliverInput) => Promise<string> = deliverFilm) {}

  snapshot (projectId: string): PrepEntry | null {
    return this.entries.get(projectId) ?? null
  }

  /**
   * 请求一份。已经在混就返回现有的那条，混好了就直接返回。
   *
   * @param masterBytes 母带大小，用来估临时空间
   */
  request (projectId: string, input: DeliverInput, masterBytes: number): PrepEntry {
    const cur = this.entries.get(projectId)
    if (cur && cur.state !== 'error') {
      cur.waiters += 1
      return cur          // ← 去重：并到同一个任务上，不再起第二个 ffmpeg
    }

    const entry: PrepEntry = {
      projectId, state: 'mixing', path: null, error: null,
      waiters: 1, startedAt: Date.now(),
    }
    this.entries.set(projectId, entry)

    this.work.set(projectId, (async () => {
      try {
        /*
         * 【先看磁盘】。不看的话，ffmpeg 会一路写到 No space left 才失败——
         * 那时它已经占了几百 MB，而且报出来的错和"磁盘"这两个字离得很远
         * （踩过：症状是 502、是"下载点了没反应"，查半天才发现是盘满）。
         */
        const need = Math.round(masterBytes * SPACE_FACTOR) + SPACE_HEADROOM
        const free = await freeBytes(input.dir)
        if (free < need) {
          const gb = (n: number): string => (n / 1024 / 1024 / 1024).toFixed(1)
          throw new Error(
            `磁盘空间不够：还需要约 ${gb(need)}G，现在只剩 ${gb(free)}G。` +
            '删掉几条旧项目再试。')
        }
        entry.path = await this.deliver(input)
        entry.state = 'ready'
      } catch (e) {
        entry.state = 'error'
        entry.error = e instanceof Error ? e.message : '现混失败'
      } finally {
        this.work.delete(projectId)
      }
    })())

    return entry
  }

  /** 等这一份混完（已经混完就立刻返回） */
  async wait (projectId: string): Promise<PrepEntry | null> {
    await this.work.get(projectId)
    return this.entries.get(projectId) ?? null
  }

  /**
   * 取走了。**取走即作废**——下一次下载要按那时的设置重新混，
   * 否则用户改完音量再下，拿到的还是旧的那一份。
   */
  drop (projectId: string): void {
    this.entries.delete(projectId)
    this.work.delete(projectId)
  }

  /** 设置变了：作废还没取走的那份。混到一半的让它跑完，取的时候会发现已作废 */
  invalidate (projectId: string): void {
    const e = this.entries.get(projectId)
    if (e && e.state === 'ready') this.entries.delete(projectId)
  }
}

/** 全进程一个。队列本来就是进程内的，见 queue/queue.ts 的说明 */
export const downloadPrep = new DownloadPrep()
