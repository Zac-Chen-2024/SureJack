import { create } from 'zustand'
import { api } from '../api/client'

/**
 * 下载的【备货】阶段。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 成片是下载那一刻才现混的，一条十几分钟的片子要混几十秒。原来这段时间
 * 界面上【什么都没有】——用户以为没点上，连点几下，每一下在服务端各起
 * 一个 ffmpeg，把磁盘撑爆（线上真这么坏过，症状只是"下载键点了没反应"）。
 *
 * 所以点下载之后的第一件事不是等，而是【立刻给个东西看】：
 *   点一下 → ghost 提示「已进入下载队列」→ 队列里这条显示「合成中…」
 *          → 混好了自动转成真正的下载，显示百分比和速度
 *
 * ── 和原生下载的分工 ────────────────────────────────────────────────
 * 混好之前这条只活在网页里；混好之后交给安卓 DownloadManager（断点续传、
 * 通知栏进度都免费得到），网页这边的记录就撤掉，由 SJNative.downloads()
 * 接管显示。两段拼起来才是用户眼里"一条下载"。
 */

/**
 * mixing = 服务端在混音；handoff = 混好了，正在交给原生下载器接手。
 *
 * ⚠️【handoff 这一档是补出来的，不是装饰】。原来混好就立刻把这条撤掉，
 * 于是出现一个【空窗】：网页这条没了，而原生那条要等下一次轮询（1 秒）
 * 才出现——用户看到"合成中"闪一下消失，以为没点上，就再点一次。
 * 而那道"已经在队列里了"的守卫正好也随着撤销失效了，第二次点畅通无阻。
 *
 * 线上的后果是同一条 458MB 的成片有【三条流】在抢带宽：两条各自续传到
 * 51MB 和 118MB，第三条每次从 0 开始。42 分钟发出 202MB，实际只推进到
 * 126MB。她那条管子本来就只有几十 KB/s。
 */
export type PrepPhase = 'mixing' | 'handoff' | 'error'

export interface Preparing {
  projectId: string
  name: string
  phase: PrepPhase
  error: string | null
}

interface DownloadsState {
  /** 正在备货的（还没交给原生下载器的那一段） */
  preparing: Record<string, Preparing>
  /** 一句话提示，两秒后自己消失 */
  ghost: string | null
  showGhost: (msg: string) => void
  /**
   * 开始下载。preset='default' 用出厂音量，否则用这条项目自己的设置。
   * 【立刻返回】——它只负责把状态摆好，混音在服务端跑。
   */
  start: (projectId: string, name: string, preset?: 'mine' | 'default') => void
  dismiss: (projectId: string) => void
}

let ghostTimer: ReturnType<typeof setTimeout> | null = null

export const useDownloads = create<DownloadsState>((set, get) => ({
  preparing: {},
  ghost: null,

  showGhost (msg) {
    set({ ghost: msg })
    if (ghostTimer !== null) clearTimeout(ghostTimer)
    ghostTimer = setTimeout(() => set({ ghost: null }), 2200)
  },

  start (projectId, name, preset = 'mine') {
    /*
     * 【已经在备货就不重复发】。服务端也会去重，但客户端先挡一道：
     * 少一次往返，而且队列里不会闪出两条一样的。
     */
    // 混音中【和】交接中都要挡——交接那一小段正是用户会重复点的时候
    const phase = get().preparing[projectId]?.phase
    if (phase === 'mixing' || phase === 'handoff') {
      get().showGhost('这条已经在队列里了')
      return
    }

    set((st) => ({
      preparing: {
        ...st.preparing,
        [projectId]: { projectId, name, phase: 'mixing', error: null },
      },
    }))
    get().showGhost('已进入下载队列')

    void (async () => {
      try {
        await api.post(`/api/projects/${projectId}/download/prepare`, { preset })
        /*
         * 轮询到混好为止。2 秒一次：混音是几十秒量级，再密只是白问。
         * 【没有超时上限】——十几分钟的片子混起来本来就慢，硬设个上限
         * 只会在最需要它的时候把用户踢出去。真挂了服务端会回 error。
         */
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000))
          const s = await api.get<{ state: string; error: string | null }>(
            `/api/projects/${projectId}/download/state`)
          if (s.state === 'ready') break
          if (s.state === 'error' || s.state === 'none') {
            throw new Error(s.error ?? '合成失败')
          }
        }
        /*
         * 混好了：交给浏览器/原生下载器去拉。用一个临时的 <a> 触发，
         * 而不是 location.href——后者在 WebView 里会把当前页面导航掉。
         */
        /*
         * 【先改状态，再触发下载】。顺序反过来的话，点击到状态更新之间
         * 仍然有一小段窗口是"什么都没有"。
         */
        set((st) => ({
          preparing: {
            ...st.preparing,
            [projectId]: { projectId, name, phase: 'handoff', error: null },
          },
        }))
        const a = document.createElement('a')
        a.href = `/api/projects/${projectId}/film/download`
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        /*
         * 【等原生那条真的出现了才撤】。撤早了就是上面说的空窗。
         * 兜底 20 秒：原生桥不存在（普通浏览器）或者接管失败时，
         * 这条也不能永远挂在那儿。
         */
        const bridge = (window as unknown as { SJNative?: { downloads?: () => string } }).SJNative
        if (typeof bridge?.downloads !== 'function') {
          setTimeout(() => get().dismiss(projectId), 3000)
          return
        }
        const until = Date.now() + 20_000
        const wait = setInterval(() => {
          let taken = false
          try {
            const list = JSON.parse(bridge.downloads!()) as { title?: string }[]
            taken = Array.isArray(list) && list.length > 0
          } catch { /* 桥出问题就靠下面的超时兜底 */ }
          if (taken || Date.now() > until) {
            clearInterval(wait)
            get().dismiss(projectId)
          }
        }, 500)
      } catch (e) {
        set((st) => ({
          preparing: {
            ...st.preparing,
            [projectId]: {
              projectId, name, phase: 'error',
              error: e instanceof Error ? e.message : '合成失败',
            },
          },
        }))
      }
    })()
  },

  dismiss (projectId) {
    set((st) => {
      const next = { ...st.preparing }
      delete next[projectId]
      return { preparing: next }
    })
  },
}))
