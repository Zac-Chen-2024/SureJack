import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../api/client'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'

/**
 * 「忘了密码」弹窗：报出生日的月和日，对上了就地改密码。
 *
 * ⚠️【别把这个当成安全机制】。月+日只有 366 种可能，真正拦住枚举的
 * 只有后端那条每小时 5 次的限流（见 src/auth/routes.ts）。这里也因此
 * 【绝不能做前端预校验或给任何提示】——比如"这天好像没人过生日"，
 * 那等于把猜测成本降到零。对错一律由后端说了算，而它只会回同一句话。
 *
 * 也【不问是谁】：报生日的人本来就该知道自己是谁，多问一个姓名字段
 * 只是多一个可以试探的输入。改完哪个账号由后端按生日反查。
 */
export function ForgotPassword ({ onClose }: { onClose: () => void }) {
  const [month, setMonth] = useState('')
  const [day, setDay] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Esc 关掉。弹窗不给退路是很烦人的事
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function onSubmit (e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/forgot-password', {
        month: Number(month), day: Number(day), newPassword: password,
      })
      setDone(true)
    } catch (err) {
      /*
       * 后端说什么就显示什么，一个字都不加工。答错时它回的是「想混进来？」，
       * 429 时是限流的话——这两句都不该被前端改写成"更友好"的版本，
       * 那样会把"你答错了"和"你被限流了"混成一句，自己都不知道发生了什么。
       */
      setError(err instanceof ApiError ? err.message : '出错了，稍后再试')
    } finally {
      setBusy(false)
    }
  }

  return (
    // 遮罩：点空白处关闭
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-[360px] rounded-2xl border border-line bg-ink-900 p-8">
        {done ? (
          <>
            <div className="mb-1 text-lg font-semibold text-ink-50">改好了</div>
            <div className="mb-6 text-sm leading-relaxed text-ink-400">
              用新密码登录吧。
            </div>
            <Button variant="primary" className="w-full" onClick={onClose}>回登录</Button>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <div className="mb-1 text-lg font-semibold text-ink-50">你的生日是什么？</div>
            <div className="mb-6 text-sm leading-relaxed text-ink-400">
              只要月和日。答对了就能直接设一个新密码。
            </div>

            {/*
              下拉选而不是手打。手打要处理"03"和"3"、全角数字、
              13 月、2 月 31 日……每一样都得写校验，而选择框从源头上
              就不存在这些输入。

              【日固定给 31 天，不跟着月份缩】：这里问的是生日，不是
              一个真实日历上的日期——2 月 30 日选出来只会被后端判为
              "没人是这天生日"，而按月份动态改选项会让"选了 31 号再
              改成 2 月"变成一个要处理的状态。不值得。
            */}
            <div className="flex items-center gap-2">
              <Select value={month} onChange={(e) => setMonth(e.target.value)} autoFocus>
                <option value="">月</option>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1} 月</option>
                ))}
              </Select>
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                <option value="">日</option>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1} 日</option>
                ))}
              </Select>
            </div>

            <Input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="新密码（至少4位）" autoComplete="new-password" className="mt-3"
            />

            {error !== null && <div className="mt-3 text-sm text-danger">{error}</div>}

            <Button
              type="submit" variant="primary" className="mt-5 w-full"
              disabled={busy || !month.trim() || !day.trim() || password.length < 4}
            >
              {busy ? '核对中…' : '改密码'}
            </Button>
            <button
              type="button" onClick={onClose}
              className="mt-3 w-full text-xs text-ink-400 transition-colors hover:text-ink-100"
            >
              算了
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
