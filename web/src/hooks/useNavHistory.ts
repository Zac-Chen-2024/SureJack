import { useEffect } from 'react'
import { useNav } from '../store/nav'

/**
 * 把导航栈接到浏览器 History：进页面 pushState、返回（系统返回键 / 左缘左滑 /
 * 桌面浏览器后退）触发 popstate → 退栈。挂一次（在 MobileWorkspace 顶层）。
 *
 * ── 根页返回由【原生】管，这里不再插手 ────────────────────────────────
 * 安卓壳已改成原生 WebView（见 android/native）：返回键先由 MainActivity 接，
 * `webView.canGoBack()` 为真就退栈（走到这里的 popstate），到根页则弹原生
 * AlertDialog 挽留。所以这里【绝不能】再垫 guard 记录——那会让 canGoBack
 * 永远为真，原生永远判不出"已在根页"，挽留框就再也不弹了（TWA 时代的
 * History hack 已连同 TWA 一起废弃）。
 */
export function useNavHistory (): void {
  const syncDepth = useNav((s) => s.syncDepth)
  useEffect(() => {
    try { history.replaceState({ sjDepth: 0 }, '') } catch { /* 非浏览器忽略 */ }
    const onPop = (e: PopStateEvent): void => {
      const st = (e.state ?? {}) as { sjDepth?: number }
      syncDepth(typeof st.sjDepth === 'number' ? st.sjDepth : 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [syncDepth])
}
