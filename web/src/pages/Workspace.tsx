import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { useProjects } from '../store/projects'
import { ProjectList } from '../components/ProjectList'
import { ScriptEditor } from '../components/ScriptEditor'
import { Button } from '../components/ui/Button'

/**
 * 三栏布局（设计文档第 11 节）：
 *   左：可折叠项目列表
 *   中：主区 —— 文案编辑；预览+时间轴留给 3B
 *   右：属性面板 —— 3B 填
 * 分栏靠背景色差异区分，不靠边框线（排版优先于框线）。
 */
export function Workspace () {
  const [collapsed, setCollapsed] = useState(false)
  const { name, logout } = useSession()
  const { load, current } = useProjects()
  useEffect(() => { load() }, [load])
  const project = current()

  return (
    <div className="flex h-full">
      {/* 左：项目列表 */}
      <aside className={`flex flex-col bg-ink-900 transition-all duration-200 ${collapsed ? 'w-14' : 'w-64'}`}>
        <div className="flex h-14 items-center justify-between px-3">
          {!collapsed && <span className="text-sm font-semibold tracking-tight text-ink-50">SureJack</span>}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            title={collapsed ? '展开' : '收起'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {!collapsed && <ProjectList />}
        </div>
        {!collapsed && (
          <div className="p-2">
            <div className="mb-1 px-2 text-xs text-ink-400">{name}</div>
            <Button className="w-full justify-start" onClick={logout}>登出</Button>
          </div>
        )}
      </aside>

      {/* 中：主区 */}
      <main className="flex flex-1 flex-col bg-ink-950">
        <div className="flex h-14 items-center px-6">
          <span className="text-sm font-medium text-ink-100">{project?.name ?? '选一个项目开始'}</span>
        </div>
        <div className="flex-1 px-6 pb-6"><ScriptEditor /></div>
      </main>

      {/* 右：属性面板 */}
      <aside className="w-72 bg-ink-900 p-4">
        <div className="text-xs text-ink-400">属性面板（阶段 3B）</div>
      </aside>
    </div>
  )
}
