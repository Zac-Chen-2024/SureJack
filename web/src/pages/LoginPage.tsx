import { useState, type FormEvent } from 'react'
import { useSession } from '../store/session'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

export function LoginPage () {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const { login, error, busy } = useSession()

  function onSubmit (e: FormEvent) {
    e.preventDefault()
    if (name.trim() && password) login(name.trim(), password)
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      {/* 卡片给登录框一点重量——细描边 + 比页面底色亮一档，
          让它读作"一件物体"而不是漂浮在纯黑上的几行文字 */}
      <form onSubmit={onSubmit} className="w-full max-w-[360px] rounded-2xl border border-line bg-ink-900 p-8">
        {/* 排版建立层级：靠字号字重和字距，不靠额外框线 */}
        <div className="mb-1 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink-50">SureJack</div>
        <div className="mb-8 text-sm text-ink-400">输入你的名字</div>

        <div className="space-y-3">
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="姓名" autoFocus autoComplete="username"
          />
          <Input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="密码" autoComplete="current-password"
          />
        </div>

        {error && <div className="mt-3 text-sm text-danger">{error}</div>}

        <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy || !name.trim() || !password}>
          {busy ? '进入中…' : '进入'}
        </Button>

        <div className="mt-4 text-xs leading-relaxed text-ink-400">
          第一次进来会把这个密码设为你的密码。
        </div>
      </form>
    </div>
  )
}
