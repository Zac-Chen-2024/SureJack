/**
 * 头像。方形圆角而不是正圆——正圆读作"社交头像"，方圆读作"账户标识"，
 * 后者才是这里的语义。同样的形状语言也用在项目卡片、素材缩略图上。
 *
 * 没有真实头像图，用姓名首字 + 柔和底色代替——这是无头像场景的标准做法，
 * 比一行光秃秃的姓名文字更成"组件"，也让侧栏底部有一个视觉锚点。
 *
 * 底色不引入新颜色：用琥珀强调色的低透明度版本，与整体配色保持一体。
 */
interface AvatarProps {
  name: string
  className?: string
}

/** 取姓名的第一个字符（按码点，兼容 emoji/生僻字） */
function initial (name: string): string {
  return [...name][0] ?? '?'
}

export function Avatar ({ name, className = '' }: AvatarProps) {
  return (
    <div
      className={`inline-flex size-8 shrink-0 select-none items-center justify-center rounded-lg border border-line-strong bg-accent/12 text-[13px] font-medium text-accent ${className}`}
      title={name}
      aria-hidden="true"
    >
      {initial(name)}
    </div>
  )
}
