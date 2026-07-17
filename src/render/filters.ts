import type { Clip, AspectPreset } from '../types.js'

/**
 * 构造把一个片段塞进目标画幅的滤镜链。
 *
 * ⚠️ 坐标系必须和前端预览严格一致（设计文档第 15 节风险 5）。
 * cropOffset 的定义：裁切窗口中心在源画面中的归一化位置，0..1。
 */
export function buildFitFilter (
  clip: Clip, aspect: AspectPreset, inLabel: string, outLabel: string,
): string {
  const { width: W, height: H } = aspect

  // 源裁剪：切掉烧死的字幕之类，在任何缩放之前做
  const pre = clip.sourceCrop
    ? `crop=${clip.sourceCrop.w}:${clip.sourceCrop.h}:${clip.sourceCrop.x}:${clip.sourceCrop.y},`
    : ''

  switch (clip.fitMode) {
    case 'cover':
      return `[${inLabel}]${pre}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:(iw-ow)*${clip.cropOffsetX}:(ih-oh)*${clip.cropOffsetY}[${outLabel}]`

    case 'contain':
      return `[${inLabel}]${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[${outLabel}]`

    case 'blur': {
      // 先缩到小尺寸再模糊，然后放大。直接对 1080x1920 做大 sigma 的高斯模糊
      // 会慢得离谱，而模糊本身掩盖了放大的画质损失——观感完全一样。
      const bw = Math.round(W / 4), bh = Math.round(H / 4)
      return `[${inLabel}]${pre}split=2[fg_${outLabel}][bgsrc_${outLabel}];` +
        `[bgsrc_${outLabel}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,` +
        `crop=${bw}:${bh},gblur=sigma=8,scale=${W}:${H},` +
        `eq=brightness=-0.18:saturation=0.7[bg_${outLabel}];` +
        `[fg_${outLabel}]scale=${W}:-2[fgs_${outLabel}];` +
        `[bg_${outLabel}][fgs_${outLabel}]overlay=(W-w)/2:(H-h)/2[${outLabel}]`
    }
  }
}

/**
 * 构造音频滤镜。
 *
 * 输入约定：[1:a] 是配音，[2:a] 是 BGM（若有）。
 * 背景视频的原声【一律丢弃】——不 map 就是了。
 */
export function buildAudioFilter (hasBgm: boolean, bgmVolume: number): string {
  if (!hasBgm) return '[1:a]anull[aout]'

  // normalize=0：amix 默认会把所有输入按数量等比压低，配音会突然变小声。
  // duration=first：以配音为准，BGM 长了截断。
  return `[1:a]volume=1.0[voice];[2:a]volume=${bgmVolume}[bgmq];` +
    `[voice][bgmq]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
}
