import { create } from 'zustand'
import { api, ApiError } from '../api/client'

interface WhoAmI { name: string | null; welcome: string | null }

interface SessionState {
  name: string | null
  welcome: string | null
  /** unknown=还没问过后端；anon=未登录；authed=已登录 */
  status: 'unknown' | 'anon' | 'authed'
  error: string | null
  busy: boolean
  check: () => Promise<void>
  login: (name: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  name: null, welcome: null, status: 'unknown', error: null, busy: false,

  /** 页面加载时问一次"我是谁"——刷新后保持登录态靠这个 */
  async check () {
    try {
      const me = await api.get<WhoAmI>('/api/whoami')
      set(me.name
        ? { name: me.name, welcome: me.welcome, status: 'authed' }
        : { name: null, welcome: null, status: 'anon' })
    } catch {
      set({ status: 'anon' })
    }
  },

  async login (name, password) {
    set({ busy: true, error: null })
    try {
      await api.post('/api/login', { name, password })
      const me = await api.get<WhoAmI>('/api/whoami')
      set({ name: me.name, welcome: me.welcome, status: 'authed', busy: false })
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '登录失败', busy: false })
    }
  },

  async logout () {
    await api.post('/api/logout').catch(() => { /* 登出失败也要清本地状态 */ })
    set({ name: null, welcome: null, status: 'anon' })
  },
}))
