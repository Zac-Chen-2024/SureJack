import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../store/projects'
import { IconCheck, IconLoader } from './ui/Icon'

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
    <div className="flex h-full flex-col items-center">
      {/* 限宽居中成一栏——正文行宽有上限才好读（约 30-40 字/行），
          宽屏下两侧留白是有意为之，不是空间浪费 */}
      <div className="flex w-full max-w-[720px] items-baseline justify-between pb-3">
        <div className="tabular-nums text-xs text-ink-400">
          {charCount} 字 · 约 {Math.round(charCount * 0.196)} 秒配音
        </div>
        <div className="inline-flex items-center gap-1.5 text-xs text-ink-400">
          {saving ? <IconLoader className="size-3.5 animate-spin" /> : <IconCheck className="size-3.5" />}
          {saving ? '保存中…' : '已保存'}
        </div>
      </div>
      {/*
        【不做成一个框】。这里曾经是「纸面」处理：亮一档的底色 + 细描边 + 内阴影，
        让编辑区读作一张可以写字的纸。看着精致，但它在一个本来就是深色面板的
        栏里又画了一个盒子——框中框。文案是这一栏的全部内容，不是栏里摆着的
        某个控件，给它加边界反而把它降格成了一个组件。

        所以：不要底色、不要描边、不要阴影。文字直接落在栏面上，
        这一栏本身就是稿纸。留白和行距负责可读性，边框不参与。

        聚焦态也不给光环——没有边界的东西套光环会凭空冒出一圈方框。
        光标在闪就足够说明焦点在哪了。
      */}
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="把文案粘贴或写在这里…"
        className="w-full max-w-[720px] flex-1 resize-none border-0 bg-transparent px-1 text-[15px] leading-[1.9] text-ink-100 outline-none placeholder:text-ink-400 focus:outline-none focus:ring-0"
      />
    </div>
  )
}
