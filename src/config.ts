import { execFileSync } from 'node:child_process'
import type { AspectPreset } from './types.js'

/**
 * ⚠️ 必须精确是 'Noto Sans CJK SC'，不是 'Noto Sans SC'。
 * fc-match 找不到族名时会【静默回退】到 DejaVu Sans（零个中文字形），
 * 表现是字幕渲染成方块或完全不显示，而 ffmpeg 不报任何错误。
 * 已在阶段 0 踩过，见 docs/superpowers/spikes/RESULTS.md。
 */
export const FONT_FAMILY = 'Noto Sans CJK SC'
export const FONTS_DIR = '/usr/share/fonts/opentype/noto'

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
  let out: string
  try {
    out = execFileSync('fc-match', [FONT_FAMILY], { encoding: 'utf-8' })
  } catch {
    throw new Error('fc-match 不可用，无法校验字体。请确认已安装 fontconfig')
  }
  if (!out.includes(FONT_FAMILY)) {
    throw new Error(
      `字体族名 "${FONT_FAMILY}" 解析失败，fc-match 回退到了：${out.trim()}\n` +
      `请安装 fonts-noto-cjk：sudo apt-get install -y fonts-noto-cjk`
    )
  }
}
