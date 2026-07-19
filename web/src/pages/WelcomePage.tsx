import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { AmbientBackdrop } from '../components/AmbientBackdrop'

/** 停留多久。够看清那句话，又不至于让人等 */
const DWELL_MS = 1600

/**
 * 登录后的专属欢迎页。文案由后端按姓名给（config/welcome.json，不入库）。
 *
 * 【不需要点击】：这一页没有任何决策，只是一句问候。放一个「开始」按钮
 * 等于每次登录都多要一次点击，而那次点击不承载任何信息。淡入、停留、
 * 自动进入——用户看到了那句话，然后工作台就在那儿了。
 *
 * 淡出也做：直接切换会显得页面"跳"了一下，像出错。
 */
export function WelcomePage ({ onEnter }: { onEnter: () => void }) {
  const { welcome, name } = useSession()
  const [shown, setShown] = useState(false)

  useEffect(() => {
    // 进场淡入
    const t1 = setTimeout(() => setShown(true), 60)
    // 停留后淡出
    const t2 = setTimeout(() => setShown(false), 60 + DWELL_MS)
    // 淡出动画走完再真的切页，否则会看到半透明状态被硬切掉
    const t3 = setTimeout(onEnter, 60 + DWELL_MS + 500)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onEnter])

  return (
    <div className="relative flex h-full items-center justify-center px-6">
      {/* 欢迎页也铺同一套斜纹——两个页面用同一块布，切换时才不会像换了个产品 */}
      <AmbientBackdrop />
      <div
        className={`relative text-center transition-all duration-500 ${
          shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        }`}
      >
        <div className="text-[40px] font-semibold leading-tight tracking-[-0.02em] text-ink-50">
          {welcome ?? '欢迎回来'}
        </div>
        <div className="mt-2 text-sm text-ink-400">{name}</div>
      </div>
    </div>
  )
}
