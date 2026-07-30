import { useEffect } from 'react'
import { useNav } from '../store/nav'

/**
 * 把导航栈接到浏览器 History：系统返回键 / 左缘左滑触发 popstate → 退栈；
 * 在根页（列表）返回时弹"挽留"。挂一次（在 MobileWorkspace 顶层）。
 *
 * ── 为什么 guard 要用不同 URL（#a）──────────────────────────────────
 * 在最底垫一条 guard 记录、列表压在其上。踩过的坑：guard 和 list 若是
 * 【同一个 URL】，部分安卓 Chrome 在两条同 URL 记录间不稳定触发 popstate，
 * 于是根页返回直接退出、挽留框不弹。给 list 加个 `#a` 哈希、guard 不带，
 * 两条记录 URL 不同，popstate 就稳了。app 内的 editor/抽屉都压在 `#a` 上
 * （pushState 不改 URL），只有 guard 边界这一处用哈希区分。
 */
export function useNavHistory (): void {
  useEffect(() => {
    const base = location.pathname + location.search
    try {
      history.replaceState({ sj: 'guard' }, '', base)          // guard（无哈希）
      history.pushState({ sjDepth: 0 }, '', base + '#a')        // list（带 #a，与 guard 不同 URL）
    } catch { /* 非浏览器忽略 */ }

    let disarm: ReturnType<typeof setTimeout> | null = null
    const onPop = (e: PopStateEvent): void => {
      const st = (e.state ?? {}) as { sj?: string; sjDepth?: number }
      const nav = useNav.getState()
      if (st.sj === 'guard') {
        if (nav.exitPrompt) {                 // 挽留框已亮 + 再按一次 → 放行退出
          if (disarm) clearTimeout(disarm)
          try { history.back() } catch { /* ignore */ }
          return
        }
        nav.armExit()
        // 延一拍再 re-push：popstate 同步内 pushState 有的浏览器会吞掉
        setTimeout(() => { try { history.pushState({ sjDepth: 0 }, '', base + '#a') } catch { /* ignore */ } }, 0)
        if (disarm) clearTimeout(disarm)
        disarm = setTimeout(() => useNav.getState().dismissExit(), 3000)
        return
      }
      nav.syncDepth(typeof st.sjDepth === 'number' ? st.sjDepth : 0)
      if (nav.exitPrompt) nav.dismissExit()
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop); if (disarm) clearTimeout(disarm) }
  }, [])
}
