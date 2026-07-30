import { describe, it, expect } from 'vitest'
import { installedVersionCode, shouldPromptUpdate, type AppVersion } from '../../web/src/hooks/useAppUpdate'

const latest = (versionCode: number): AppVersion => ({ versionCode, versionName: 'x', apkUrl: 'u' })

describe('installedVersionCode', () => {
  it('从 ?appVersion 读整数', () => {
    expect(installedVersionCode('?appVersion=5')).toBe(5)
    expect(installedVersionCode('?a=1&appVersion=12&b=2')).toBe(12)
  })
  it('不在 TWA 里（无参数）返回 null', () => {
    expect(installedVersionCode('')).toBeNull()
    expect(installedVersionCode('?foo=bar')).toBeNull()
  })
  it('非数字返回 null', () => {
    expect(installedVersionCode('?appVersion=abc')).toBeNull()
  })
})

describe('shouldPromptUpdate', () => {
  it('装了旧版 + 有更高版 + 没忽略 → 提示', () => {
    expect(shouldPromptUpdate(1, latest(2), null)).toBe(true)
  })
  it('已是最新（相等/更高）→ 不提示', () => {
    expect(shouldPromptUpdate(2, latest(2), null)).toBe(false)
    expect(shouldPromptUpdate(3, latest(2), null)).toBe(false)
  })
  it('忽略过这一版 → 不提示', () => {
    expect(shouldPromptUpdate(1, latest(2), 2)).toBe(false)
    // 但更新的版本(3)又该提示了
    expect(shouldPromptUpdate(1, latest(3), 2)).toBe(true)
  })
  it('不在 App 里(installed=null) 或 没拿到 latest → 不提示', () => {
    expect(shouldPromptUpdate(null, latest(2), null)).toBe(false)
    expect(shouldPromptUpdate(1, null, null)).toBe(false)
  })
})
