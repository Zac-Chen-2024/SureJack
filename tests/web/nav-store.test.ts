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
