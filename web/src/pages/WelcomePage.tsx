import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { Button } from '../components/ui/Button'

/**
 * 登录后的专属欢迎页。文案由后端按姓名给（config/welcome.json，不入库）。
 * 动效有目的：淡入是"你到了"的状态转换反馈，不是装饰。
 */
export function WelcomePage ({ onEnter }: { onEnter: () => void }) {
  const { welcome, name } = useSession()
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 60)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div
        className={`text-center transition-all duration-500 ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
      >
        <div className="text-[40px] font-semibold leading-tight tracking-tight text-ink-50">
          {welcome ?? '欢迎回来'}
        </div>
        <div className="mt-2 text-sm text-ink-400">{name}</div>
        <Button variant="primary" className="mt-8 px-8" onClick={onEnter}>开始</Button>
      </div>
    </div>
  )
}
