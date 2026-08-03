import { create } from 'zustand'

/**
 * 手机版导航栈，挂在浏览器 History 上。
 *
 * ── 为什么挂 History ──────────────────────────────────────────────────
 * 这是 TWA（安卓 App 壳）。安卓的【系统返回键】和【屏幕左缘左滑】天生就是
 * 驱动浏览器历史前进/后退的——所以只要把"每一屏、每一个抽屉"都压成一条
 * history 记录，返回键和原生左滑就自动"退到上一层"，一行手势代码都不用写，
 * 而且是系统级的真跟手。我们只管：push 时压一条、popstate 时退一层。
 *
 * 栈元素：
 *   list   —— 项目列表（根）
 *   editor —— 全屏预览编辑器（起始选择是它的一个叠加态，不单独入栈）
 *   sheet  —— 底部抽屉（文案/配音/字幕/背景/音乐），叠在 editor 上
 *
 * 退栈语义天然正确：栈顶是 sheet → 退回 editor（关抽屉）；是 editor → 退回
 * list；在 list（根）按返回 → 浏览器默认行为（TWA 里=退出 App），符合直觉。
 */
export type Sheet = 'script' | 'voice' | 'subtitle' | 'background' | 'music'
export type NavEntry = { k: 'list' } | { k: 'newproject' } | { k: 'opening' } | { k: 'editor' } | { k: 'sheet'; name: Sheet }
export type Screen = 'list' | 'newproject' | 'opening' | 'editor'

/** 当前该渲染哪一屏（抽屉不改变底层屏） */
export function topScreen (stack: NavEntry[]): Screen {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]!
    if (e.k !== 'sheet') return e.k
  }
  return 'list'
}
/** 栈顶是不是抽屉，是哪个 */
export function topSheet (stack: NavEntry[]): Sheet | null {
  const t = stack[stack.length - 1]
  return t && t.k === 'sheet' ? t.name : null
}

interface NavState {
  stack: NavEntry[]
  /** 上一次变化的方向，驱动进/退不同的转场 */
  dir: 'fwd' | 'back'
  push: (e: NavEntry) => void
  /** 原地替换栈顶（不新增历史记录）。如新建页完成后换成 editor：回退直接到列表 */
  replace: (e: NavEntry) => void
  /** 退一层——走 history.back()，由 popstate 统一落地（和系统返回键同一条路） */
  back: () => void
  /** popstate 回调：把栈裁到目标深度 */
  syncDepth: (depth: number) => void
  /** 回到根（如切换用户）——清栈 */
  resetToRoot: () => void
}

function pushHistory (depth: number): void {
  try { history.pushState({ sjDepth: depth }, '') } catch { /* 非浏览器环境忽略 */ }
}

export const useNav = create<NavState>((set, get) => ({
  stack: [{ k: 'list' }],
  dir: 'fwd',

  push (e) {
    const stack = [...get().stack, e]
    set({ stack, dir: 'fwd' })
    pushHistory(stack.length - 1)
  },

  replace (e) {
    const stack = [...get().stack]
    stack[stack.length - 1] = e
    set({ stack, dir: 'fwd' })
    try { history.replaceState({ sjDepth: stack.length - 1 }, '') } catch { /* 非浏览器忽略 */ }
  },

  back () {
    // 有历史就交给 history.back()（与系统返回键/左滑同一入口，popstate 落地）；
    // 兜底：万一没有对应历史记录，也在本地退一层，不至于卡死。
    if (get().stack.length <= 1) return
    try { history.back() } catch { get().syncDepth(get().stack.length - 2) }
  },

  syncDepth (depth) {
    const target = Math.max(0, depth)
    set((s) => ({ stack: s.stack.slice(0, target + 1), dir: 'back' }))
  },

  resetToRoot () {
    set({ stack: [{ k: 'list' }], dir: 'back' })
    try { history.replaceState({ sjDepth: 0 }, '') } catch { /* ignore */ }
  },
}))
