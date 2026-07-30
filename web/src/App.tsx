import { useEffect, useState } from 'react'
import { useSession } from './store/session'
import { LoginPage } from './pages/LoginPage'
import { WelcomePage } from './pages/WelcomePage'
import { Workspace } from './pages/Workspace'
import { MobileWorkspace } from './pages/MobileWorkspace'
import { useIsMobile } from './hooks/useIsMobile'

export default function App () {
  const { status, check } = useSession()
  const isMobile = useIsMobile()
  const [entered, setEntered] = useState(false)

  useEffect(() => { check() }, [check])

  // 还没问完后端时不闪登录页——避免已登录用户看到一瞬间的登录框
  if (status === 'unknown') {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">载入中…</div>
  }
  if (status === 'anon') return <LoginPage />
  /*
   * 【交叉淡出，不要先卸载再挂载】。以前是"欢迎页整页替换成工作台"，于是
   * 欢迎页淡出后有一小段既没有欢迎页也没有工作台的空档 → 看起来就是黑屏
   * 闪一下。现在工作台【先在底下挂好】（顺便利用这段时间把项目列表等数据
   * 拉完），欢迎页当作覆盖层盖在上面整体淡出——观感是一层揭开，没有断点。
   */
  return (
    <>
      {isMobile ? <MobileWorkspace /> : <Workspace />}
      {!entered && <WelcomePage onEnter={() => setEntered(true)} />}
    </>
  )
}
