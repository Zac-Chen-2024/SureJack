import { useState } from 'react'
import { useProjects } from '../store/projects'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

export function ProjectList () {
  const { items, currentId, select, create, remove } = useProjects()
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  async function submitNew () {
    const name = newName.trim()
    if (!name) return
    await create(name)
    setNewName(''); setAdding(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-2">
        {adding ? (
          <Input
            autoFocus value={newName} placeholder="项目名"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew()
              if (e.key === 'Escape') { setAdding(false); setNewName('') }
            }}
            onBlur={() => { if (!newName.trim()) setAdding(false) }}
          />
        ) : (
          <Button className="w-full justify-start" onClick={() => setAdding(true)}>＋ 新建项目</Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ink-600" aria-hidden="true">
              <path
                d="M4 4.5A1.5 1.5 0 0 1 5.5 3h6.379a1.5 1.5 0 0 1 1.06.44l3.622 3.62A1.5 1.5 0 0 1 17 8.12V19.5A1.5 1.5 0 0 1 15.5 21h-10A1.5 1.5 0 0 1 4 19.5v-15Z"
                stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
              />
              <path d="M12 3.4V7a1 1 0 0 0 1 1h3.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M8 13.5h8M8 16.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <div className="text-xs leading-relaxed text-ink-400">
              还没有项目<br />新建一个开始写文案
            </div>
          </div>
        )}
        {items.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => select(p.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id) } }}
            className={`group interactive mb-1 flex cursor-pointer items-center justify-between rounded-lg border border-l-2 px-3 py-2.5 ${
              p.id === currentId
                ? 'border-line-strong border-l-accent bg-ink-700'
                : 'border-transparent border-l-transparent hover:border-line hover:bg-ink-850'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className={`truncate text-sm font-medium ${p.id === currentId ? 'text-ink-50' : 'text-ink-100'}`}>
                {p.name}
              </div>
              <div className="mt-1 truncate text-xs tabular-nums text-ink-400">
                {p.scriptText ? `${[...p.scriptText].length} 字` : '空文案'}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); if (confirm(`删除「${p.name}」？`)) remove(p.id) }}
              className="ml-2 hidden rounded-lg p-1 text-ink-400 hover:text-danger group-hover:block"
              title="删除"
            >×</button>
          </div>
        ))}
      </div>
    </div>
  )
}
