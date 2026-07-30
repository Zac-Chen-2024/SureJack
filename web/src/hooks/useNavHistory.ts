import { useEffect } from 'react'
import { useNav } from '../store/nav'

/**
 * 把导航栈接到浏览器 History：进页面 pushState、系统返回键/左缘左滑触发
 * popstate → 退栈。挂一次（在 MobileWorkspace 顶层）即可。
 *
 * ── 根页返回的"挽留" ──────────────────────────────────────────────────
 * 在最底下垫一条 guard 记录，列表页(depth 0)之下。于是在列表按返回不会
 * 直接退出 App，而是 popstate 落到 guard → 弹"我走了你别再难过！"挽留框，
 * 并 re-push 回列表（留下）。若挽留框已亮着又按一次返回 → 这次放行，真的
 * 退出（"再按一次返回键退出"）。
 */
export function useNavHistory (): void {
  useEffect(() => {
    // guard 垫底，list 压在其上；当前停在 list
    try {
      history.replaceState({ sj: 'guard' }, '')
      history.pushState({ sjDepth: 0 }, '')
    } catch { /* 非浏览器忽略 */ }

    let disarm: ReturnType<typeof setTimeout> | null = null
    const onPop = (e: PopStateEvent): void => {
      const st = (e.state ?? {}) as { sj?: string; sjDepth?: number }
      const nav = useNav.getState()
      if (st.sj === 'guard') {
        // 从列表退到了 guard = 想退出 App
        if (nav.exitPrompt) {
          // 挽留框已亮 + 又按一次 → 放行退出（再从 guard 往回就离开 App）
          if (disarm) clearTimeout(disarm)
          try { history.back() } catch { /* ignore */ }
          return
        }
        nav.armExit()
        try { history.pushState({ sjDepth: 0 }, '') } catch { /* ignore */ } // 回到列表、留下
        if (disarm) clearTimeout(disarm)
        disarm = setTimeout(() => useNav.getState().dismissExit(), 3000)
        return
      }
      nav.syncDepth(typeof st.sjDepth === 'number' ? st.sjDepth : 0)
      if (nav.exitPrompt) nav.dismissExit()   // 有真实导航就收起挽留框
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop); if (disarm) clearTimeout(disarm) }
  }, [])
}
