import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AspectPreset } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 烧录用的字体族。
 *
 * ⚠️【字重是拟合出来的，不是挑的】。原来用 Noto Sans CJK SC + Bold=1，
 * 用户一眼看出"我们的字比参考粗一点点"。拿参考图做两层 IoU 一比：
 *   字幕   Bold 0.790 / Regular 0.887 / Medium 0.864
 *   标题   Bold 0.832 / Regular 0.896 / Medium 0.913
 * Bold 明显是错的；Medium 在标题上最好、字幕上外轮廓也最好，取它。
 *
 * ⚠️【必须精确写全 'Source Han Sans CN Medium'】。只写 'Source Han Sans CN'
 * 会落到 Regular 上——同一个族里 Medium 是靠这个全名区分的。族名找不到时
 * libass 会【静默回退】到别的字体，表现是字形微妙地不对而不报任何错。
 * 已验证：同样一个「永」字 200 号，Bold 7089 / Medium 5745 / Regular 4621
 * 个墨迹像素，三者互不相同，说明确实各自加载到了。
 */
export const FONT_FAMILY = 'Source Han Sans CN Medium'

/**
 * 字体目录。【跟着仓库走，不依赖系统安装】——换台机器部署不用先装字体，
 * 也不会因为系统字体版本不同而渲出不一样的字。
 */
export const FONTS_DIR = join(__dirname, '..', 'assets', 'fonts')

export const ASPECT_PRESETS: Record<string, AspectPreset> = {
  '9:16': { name: '9:16', width: 1080, height: 1920 },
  '4:5': { name: '4:5', width: 1080, height: 1350 },
  '1:1': { name: '1:1', width: 1080, height: 1080 },
  '16:9': { name: '16:9', width: 1920, height: 1080 },
}

/**
 * 启动时校验字体真的可解析。
 * 静默失败的东西必须主动探测——这正是本项目踩过的坑。
 */
export function assertFontAvailable(): void {
  /*
   * 【查文件，不查 fc-match】。字体跟着仓库走、没装进系统，fc-match 当然
   * 找不到它——那条检查会永远失败。真正要防的是"目录里没有这份字体"，
   * 因为那时 libass 会静默回退到别的字体，字形微妙地不对而不报错。
   */
  if (!existsSync(FONTS_DIR)) {
    throw new Error(`字体目录不存在：${FONTS_DIR}（仓库里的 assets/fonts 丢了？）`)
  }
  const files = readdirSync(FONTS_DIR)
  if (!files.some((f) => f.startsWith('SourceHanSansCN-Medium'))) {
    throw new Error(
      `${FONTS_DIR} 里找不到 SourceHanSansCN-Medium.otf。\n` +
      '烧录的字体族是 "Source Han Sans CN Medium"，缺了它 libass 会静默回退，' +
      '成片的字形和参考对不上而且不报错。'
    )
  }
  // fontconfig 仍然要有：libass 找不到 fontsdir 里的字时靠它回退取字形
  try {
    execFileSync('fc-match', ['sans'], { encoding: 'utf-8' })
  } catch {
    throw new Error('fc-match 不可用，请确认已安装 fontconfig')
  }
}
