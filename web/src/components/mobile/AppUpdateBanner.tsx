import { useAppUpdate } from '../../hooks/useAppUpdate'
import { useWebBuild } from '../../hooks/useWebBuild'
import { IconDownload, IconLoader } from '../ui/Icon'

/**
 * 顶部"有新版"横幅（只在安卓 APK 里、且检测到更高版本时出现）。
 * 点「更新」= 打开 release 的 APK 下载链接，系统弹窗确认安装（侧载无法静默）。
 * 「×」忽略这一版，同版本不再打扰。
 */
export function AppUpdateBanner () {
  const { update, dismiss } = useAppUpdate()
  const web = useWebBuild()

  /*
   * 【界面过期优先于 APK 更新】。界面重载是一秒钟的事、而且必然有效；
   * APK 更新要下载安装。两个横幅同时出现只会让人不知道先点哪个，
   * 所以先把便宜且确定的那个推给用户。
   */
  if (web.stale) {
    return (
      <div
        className="absolute inset-x-0 top-0 z-50 flex items-center gap-2 border-b border-accent/30 bg-ink-900/95 px-4 backdrop-blur"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)', paddingBottom: '8px' }}
      >
        <span className="min-w-0 flex-1 text-xs text-ink-100">
          界面有更新 <span className="text-ink-400">· 点一下加载新版</span>
        </span>
        <button
          type="button"
          onClick={web.reload}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-ink-950"
        >
          <IconLoader className="size-3.5" strokeWidth={2.2} />刷新
        </button>
      </div>
    )
  }

  if (!update) return null
  return (
    <div
      className="absolute inset-x-0 top-0 z-50 flex items-center gap-2 border-b border-accent/30 bg-ink-900/95 px-4 backdrop-blur"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)', paddingBottom: '8px' }}
    >
      <span className="min-w-0 flex-1 text-xs text-ink-100">
        有新版本 <b className="text-accent">{update.versionName}</b>
        {update.notes ? <span className="ml-1 text-ink-400">· {update.notes}</span> : null}
      </span>
      <a
        href={update.apkUrl}
        className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-ink-950"
      >
        <IconDownload className="size-3.5" strokeWidth={2.2} />更新
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label="忽略这一版"
        className="shrink-0 px-1 text-lg leading-none text-ink-400"
      >
        ×
      </button>
    </div>
  )
}
