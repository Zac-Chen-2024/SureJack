import { useEffect, useState } from 'react'
import { BUILD_SHA } from '../build-info'

/**
 * 界面自己发现"我过期了"。
 *
 * ── 这是从一个真实的丢失里长出来的 ──────────────────────────────────
 * 分集功能上线之后，用户在 App 里找不到那个开关。代码在、构建在、部署也在，
 * 问题是**他手上那张页面是旧的**：原生壳把 WebView 留在内存里，切回 App
 * 不会重新请求页面。服务端更了新，页面自己不知道。
 *
 * index.html 已经是 no-cache，所以【只要重新加载就能拿到新版】——缺的从来
 * 不是缓存策略，而是"谁来告诉页面该重载了"。这个 hook 就是那个人。
 *
 * ── 什么时候查 ──────────────────────────────────────────────────────
 * 1. 页面重新可见时（切回 App / 切回标签页）——这正是那次丢失的场景，
 *    也是最可能"服务端已经更了好几版"的时刻。
 * 2. 每 5 分钟兜一次，覆盖"一直开着不动"的情况。
 * 频率不用高：部署是分钟级的事，而每次查只是一个几十字节的 GET。
 */

/** 每 5 分钟兜底查一次。真正管用的是"切回来就查" */
const POLL_MS = 5 * 60 * 1000

export function useWebBuild (): { stale: boolean; reload: () => void } {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    // 构建戳取不到时（比如 tar 包构建）BUILD_SHA 是 unknown，比了也没意义
    if (BUILD_SHA === 'unknown') return
    let alive = true

    const check = async (): Promise<void> => {
      try {
        // no-store：这个文件问的就是"服务器此刻是哪一版"，走缓存等于白问
        const res = await fetch('/build.json', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const { sha } = await res.json() as { sha?: string }
        if (typeof sha === 'string' && sha !== '' && sha !== BUILD_SHA) setStale(true)
      } catch {
        /* 网络不通就算了：断网时提示"界面有更新"只会让人困惑 */
      }
    }

    void check()
    const timer = setInterval(() => { void check() }, POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return { stale, reload: () => window.location.reload() }
}
