import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../store/projects'

/**
 * 文案编辑器。文案是项目的一等公民（设计文档），所以：
 *   - 打字不卡：本地即时更新，600ms 防抖后才发请求
 *   - 切项目时同步本地草稿，避免把上一个项目的文字带过去
 */
export function ScriptEditor () {
  const { current, updateScript, saving } = useProjects()
  const project = current()
  const [text, setText] = useState(project?.scriptText ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 切换项目时，把编辑框内容换成新项目的文案
  useEffect(() => { setText(project?.scriptText ?? '') }, [project?.id])

  function onChange (value: string) {
    setText(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { updateScript(value) }, 600)
  }

  // 卸载时把未保存的改动刷出去，避免切走就丢
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!project) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-400">左侧选一个项目</div>
  }

  const charCount = [...text].length

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between pb-3">
        <div className="text-xs text-ink-400">
          {charCount} 字 · 约 {Math.round(charCount * 0.196)} 秒配音
        </div>
        <div className="text-xs text-ink-400">{saving ? '保存中…' : '已保存'}</div>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="把文案粘贴或写在这里…"
        className="flex-1 resize-none rounded-xl bg-ink-900 p-5 text-[15px] leading-[1.9] text-ink-100 placeholder:text-ink-400 outline-none"
      />
    </div>
  )
}
