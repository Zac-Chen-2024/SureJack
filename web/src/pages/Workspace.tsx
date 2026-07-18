import { useEffect, useState } from 'react'
import { useSession } from '../store/session'
import { useProjects } from '../store/projects'
import { ProjectList } from '../components/ProjectList'
import { ScriptEditor } from '../components/ScriptEditor'
import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
import { IconChevronLeft, IconChevronRight, IconLogOut } from '../components/ui/Icon'

/** 把 ISO 时间格式化成本地可读的日期时间，供属性面板展示 */
function formatDate (iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * 三栏布局（设计文档第 11 节）：
 *   左：可折叠项目列表
 *   中：主区 —— 文案编辑；预览+时间轴留给 3B
 *   右：属性面板 —— 3A 先放项目基本信息，配音参数/字幕样式/文本层留给 3B
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
      {/* 左：项目列表——用细描边而不是纯背景色差把三栏"接住光"地分开 */}
      <aside className={`flex flex-col border-r border-line bg-ink-900 transition-all duration-200 ${collapsed ? 'w-14' : 'w-64'}`}>
        <div className="flex h-14 items-center justify-between border-b border-line px-3">
          {!collapsed && <span className="text-sm font-semibold tracking-[-0.02em] text-ink-50">SureJack</span>}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center justify-center rounded-lg p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            title={collapsed ? '展开' : '收起'}
          >
            {collapsed ? <IconChevronRight className="size-4" /> : <IconChevronLeft className="size-4" />}
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {!collapsed && <ProjectList />}
        </div>
        {/* 折叠时只留头像——收起状态下它是唯一还能表明「你是谁」的元素 */}
        <div className="border-t border-line p-2">
          {collapsed ? (
            <div className="flex justify-center py-1">
              <Avatar name={name ?? ''} />
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2.5 px-1.5 py-1">
                <Avatar name={name ?? ''} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">{name}</span>
              </div>
              <Button className="w-full justify-start" onClick={logout}>
                <IconLogOut className="size-4" /> 登出
              </Button>
            </>
          )}
        </div>
      </aside>

      {/* 中：主区 */}
      <main className="flex flex-1 flex-col bg-ink-950">
        <div className="flex h-14 items-center border-b border-line px-6">
          <span className="text-sm font-medium text-ink-100">{project?.name ?? '选一个项目开始'}</span>
        </div>
        <div className="flex-1 px-6 pb-6"><ScriptEditor /></div>
      </main>

      {/* 右：属性面板——3A 阶段先放项目基本信息，避免空白 */}
      <aside className="w-64 border-l border-line bg-ink-900 p-5">
        {project ? (
          <div className="space-y-3">
            <div className="text-xs font-medium tracking-wide text-ink-400">项目信息</div>
            <div className="rounded-lg border border-line bg-ink-850 p-3">
              <div className="text-xs text-ink-400">画幅</div>
              <div className="mt-1 text-sm tabular-nums text-ink-100">{project.aspectRatio}</div>
            </div>
            <div className="rounded-lg border border-line bg-ink-850 p-3">
              <div className="text-xs text-ink-400">创建于</div>
              <div className="mt-1 text-sm tabular-nums text-ink-100">{formatDate(project.createdAt)}</div>
            </div>
            <div className="rounded-lg border border-line bg-ink-850 p-3">
              <div className="text-xs text-ink-400">最近更新</div>
              <div className="mt-1 text-sm tabular-nums text-ink-100">{formatDate(project.updatedAt)}</div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-ink-400">选一个项目查看信息</div>
        )}
      </aside>
    </div>
  )
}
