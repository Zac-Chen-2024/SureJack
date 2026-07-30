import { useEffect, useState } from 'react'

/**
 * 安卓 APK 自检更新。
 *
 * ── 怎么知道"当前装的是哪版" ─────────────────────────────────────────
 * TWA 壳启动时会在网址后带上自己的 versionCode（?appVersion=N，见 android/
 * 的自定义 LauncherActivity）。网页读这个参数 = 当前安装版本。桌面浏览器
 * 打开没有这个参数 → 不提示更新（没 APK 可更）。
 *
 * ── 逻辑 ──────────────────────────────────────────────────────────────
 * 读到 installed → 拉 /api/app-version 的最新 versionCode → 更高就提示。
 * 用户可"忽略这一版"（记 localStorage，同版本不再烦）。安卓侧载装不了
 * 静默包，所以"更新"= 打开 APK 下载链接、系统弹窗确认安装。
 */
export interface AppVersion { versionCode: number; versionName: string; apkUrl: string; notes?: string }

/** 当前安装的 versionCode：从启动 URL 的 ?appVersion 读；不在 TWA 里就是 null */
export function installedVersionCode (search: string): number | null {
  const v = new URLSearchParams(search).get('appVersion')
  if (v === null) return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

/** 该不该弹更新：装在 TWA 里(installed 非空)、有更高版本、且没被忽略过 */
export function shouldPromptUpdate (
  installed: number | null,
  latest: AppVersion | null,
  dismissedCode: number | null,
): boolean {
  if (installed === null || latest === null) return false
  return latest.versionCode > installed && dismissedCode !== latest.versionCode
}

const DISMISS_KEY = 'surejack:update-dismissed'
function readDismissed (): number | null {
  try { const v = localStorage.getItem(DISMISS_KEY); return v ? Number.parseInt(v, 10) : null } catch { return null }
}

export function useAppUpdate (): { update: AppVersion | null; dismiss: () => void } {
  const [latest, setLatest] = useState<AppVersion | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(() => readDismissed())
  const installed = installedVersionCode(typeof location !== 'undefined' ? location.search : '')

  useEffect(() => {
    if (installed === null) return   // 不在 App 里，别去问
    let ok = true
    fetch('/api/app-version')
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => { if (ok && v) setLatest(v as AppVersion) })
      .catch(() => { /* 拉不到就不提示，不打扰 */ })
    return () => { ok = false }
  }, [installed])

  const show = shouldPromptUpdate(installed, latest, dismissed)
  function dismiss () {
    if (!latest) return
    try { localStorage.setItem(DISMISS_KEY, String(latest.versionCode)) } catch { /* ignore */ }
    setDismissed(latest.versionCode)
  }
  return { update: show ? latest : null, dismiss }
}
