import { useNav } from '../../store/nav'

/**
 * 根页按返回时的"挽留"框。
 *   我走了你别再难过！
 *   [ 离开 ]        [ 留下 ]
 *   小字：再按一次返回键退出
 *
 * 留下 = 收起（History 已 re-push 回列表，停在原地）。
 * 离开 = 往回越过 guard，退出 App（侧载环境尽力而为）。
 */
export function ExitPrompt () {
  const open = useNav((s) => s.exitPrompt)
  const dismiss = useNav((s) => s.dismissExit)
  if (!open) return null

  function leave () {
    dismiss()
    try { history.go(-2) } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-8">
      <button type="button" aria-label="留下" onClick={dismiss} className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-[300px] rounded-2xl border border-line bg-ink-900 p-5 text-center shadow-2xl shadow-black/70">
        <p className="text-base font-bold text-ink-50">我走了你别再难过！</p>
        <div className="mt-5 flex gap-3">
          <button
            type="button" onClick={leave}
            className="flex-1 rounded-xl border border-line py-2.5 text-sm font-semibold text-ink-300 transition-colors hover:text-ink-50"
          >
            离开
          </button>
          <button
            type="button" onClick={dismiss}
            className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-extrabold text-ink-950 transition-colors hover:bg-accent-dim"
          >
            留下
          </button>
        </div>
        <p className="mt-3 text-[11px] text-ink-500">再按一次返回键退出</p>
      </div>
    </div>
  )
}
