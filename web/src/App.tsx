import { useEffect } from 'react'
import { useSession } from './store/session'
import { LoginPage } from './pages/LoginPage'

export default function App () {
  const { status, check } = useSession()

  useEffect(() => { check() }, [check])

  // 还没问完后端时不闪登录页——避免已登录用户看到一瞬间的登录框
  if (status === 'unknown') {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">载入中…</div>
  }
  if (status === 'anon') return <LoginPage />
  return <div className="flex h-full items-center justify-center text-sm text-ink-400">已登录（工作台在 Task 6）</div>
}
