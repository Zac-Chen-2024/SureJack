import { useEffect } from 'react'
import { useNav } from '../store/nav'

/**
 * 把导航栈接到浏览器 History：进页面 pushState、系统返回键/左缘左滑触发
 * popstate → 退栈。挂一次（在 MobileWorkspace 顶层）即可。
 *
 * 进来先 replaceState 一个 depth=0 的初始态，作为栈底锚点——这样第一次
 * push 之后按返回，popstate 能拿到 {sjDepth:0} 退回列表；在列表再按返回
 * 就是浏览器默认（TWA 里退出 App）。
 */
export function useNavHistory (): void {
  const syncDepth = useNav((s) => s.syncDepth)
  useEffect(() => {
    try { history.replaceState({ sjDepth: 0 }, '') } catch { /* 非浏览器忽略 */ }
    const onPop = (e: PopStateEvent): void => {
      const d = e.state && typeof (e.state as { sjDepth?: unknown }).sjDepth === 'number'
        ? (e.state as { sjDepth: number }).sjDepth
        : 0
      syncDepth(d)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [syncDepth])
}
