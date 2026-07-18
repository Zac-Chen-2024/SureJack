import { useEffect, useState } from 'react'
import { useSession } from './store/session'
import { LoginPage } from './pages/LoginPage'
import { WelcomePage } from './pages/WelcomePage'
import { Workspace } from './pages/Workspace'

export default function App () {
  const { status, check } = useSession()
  const [entered, setEntered] = useState(false)

  useEffect(() => { check() }, [check])

  // 还没问完后端时不闪登录页——避免已登录用户看到一瞬间的登录框
  if (status === 'unknown') {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">载入中…</div>
  }
  if (status === 'anon') return <LoginPage />
  if (!entered) return <WelcomePage onEnter={() => setEntered(true)} />
  return <Workspace />
}
