import { describe, it, expect, beforeEach } from 'vitest'
import { useNav, topScreen, topSheet } from '../../web/src/store/nav'

beforeEach(() => { useNav.setState({ stack: [{ k: 'list' }], dir: 'fwd' }) })

describe('nav 派生：topScreen / topSheet', () => {
  it('抽屉不改变底层屏', () => {
    expect(topScreen([{ k: 'list' }])).toBe('list')
    expect(topScreen([{ k: 'list' }, { k: 'editor' }])).toBe('editor')
    expect(topScreen([{ k: 'list' }, { k: 'editor' }, { k: 'sheet', name: 'voice' }])).toBe('editor')
  })
  it('栈顶是抽屉才有 sheet', () => {
    expect(topSheet([{ k: 'list' }, { k: 'editor' }])).toBeNull()
    expect(topSheet([{ k: 'list' }, { k: 'editor' }, { k: 'sheet', name: 'music' }])).toBe('music')
  })
})

describe('nav 栈操作', () => {
  it('push 压栈、方向 fwd', () => {
    useNav.getState().push({ k: 'editor' })
    expect(useNav.getState().stack).toHaveLength(2)
    expect(useNav.getState().dir).toBe('fwd')
    useNav.getState().push({ k: 'sheet', name: 'script' })
    expect(topSheet(useNav.getState().stack)).toBe('script')
  })

  it('syncDepth（popstate 落地）裁到目标深度、方向 back', () => {
    useNav.getState().push({ k: 'editor' })
    useNav.getState().push({ k: 'sheet', name: 'subtitle' })
    expect(useNav.getState().stack).toHaveLength(3)
    useNav.getState().syncDepth(1)   // 退到 editor
    expect(useNav.getState().stack).toHaveLength(2)
    expect(topSheet(useNav.getState().stack)).toBeNull()
    expect(useNav.getState().dir).toBe('back')
    useNav.getState().syncDepth(0)   // 退到 list
    expect(topScreen(useNav.getState().stack)).toBe('list')
  })

  it('在根（list）back 是空操作，不炸', () => {
    useNav.getState().back()
    expect(useNav.getState().stack).toEqual([{ k: 'list' }])
  })
})

describe('配音失败之后该去哪一屏', () => {
  /*
   * ⚠️ 线上真踩的：配音失败（Azure 密钥失效，502）后 ttsState='error'，
   * 而 'error' 被算进了 inProgress → 甩到「合成中」那一屏 → 那儿唯一的按钮
   * 是「接着上次继续」（走 /retry）。可 /retry 是给**合成**链路用的，
   * 它从盘上最远的完好产物接着走；配音都没成功过，断点永远是 none，
   * retry 什么都做不了——日志里空转了 6 次。
   *
   * 这里把"该去哪一屏"抽成纯函数钉死，不用起浏览器。
   */
  type P = { ttsState: string; openingState: string }
  /** 和 MobileWorkspace 的 openProject 同一套判定 */
  const screenFor = (p: P): string => {
    const needsScript = p.ttsState === 'none' || p.ttsState === 'error'
    if (needsScript) return 'newproject'
    if (p.openingState === 'pending') return 'opening'
    return 'editor'
  }

  it('配音失败 → 回文案页（不是"合成中"那一屏）', () => {
    expect(screenFor({ ttsState: 'error', openingState: 'settled' })).toBe('newproject')
  })

  /*
   * 新建那条线是先挂起闸门(opening/hold)再发配音的，所以配音一失败，
   * 项目就停在 pending + error 上。先判 pending 会把她送进挑选界面——
   * 那一屏要等配音时长才画得出目标，她会对着「配音生成中」永远等下去。
   */
  it('配音失败【优先于】开头待挑', () => {
    expect(screenFor({ ttsState: 'error', openingState: 'pending' })).toBe('newproject')
  })

  it('还没配过 → 也回文案页', () => {
    expect(screenFor({ ttsState: 'none', openingState: 'settled' })).toBe('newproject')
  })

  it('配音好了、开头还没挑 → 挑选界面', () => {
    expect(screenFor({ ttsState: 'ready', openingState: 'pending' })).toBe('opening')
  })

  it('都齐了 → 编辑器', () => {
    expect(screenFor({ ttsState: 'ready', openingState: 'settled' })).toBe('editor')
  })
})
