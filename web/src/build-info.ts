/**
 * 构建版本戳。由 vite.config.ts 的 define 在构建时注入。
 *
 * 【为什么存在】：改完代码提交了但忘了重新构建+重启，线上跑的还是旧版，
 * 而界面上看不出任何差别——只有真去点那个新功能才发现它不存在。
 * 这个坑踩过：BGM 预览播放本地"做完了"，线上九小时前的代码里根本没有。
 */
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

export const BUILD_SHA = __BUILD_SHA__
export const BUILD_TIME = __BUILD_TIME__

/** 本地时区的构建时刻，形如 07-19 21:03 */
export function buildTimeLocal (): string {
  const d = new Date(BUILD_TIME)
  if (Number.isNaN(d.getTime())) return '?'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 开机在控制台打一行，方便直接看线上是哪一版 */
export function logBuildInfo (): void {
  // eslint-disable-next-line no-console
  console.info(
    `%cSureJack%c ${BUILD_SHA} · 构建于 ${buildTimeLocal()}`,
    'background:#f0b429;color:#08080a;padding:2px 6px;border-radius:3px;font-weight:600',
    'color:#9c9caa',
  )
}
