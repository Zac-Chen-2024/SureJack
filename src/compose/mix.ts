import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'

/**
 * 把背景音乐混进【已经渲染好的母带】。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 视频和烧录字幕是贵的（十几分钟），背景音乐只是一条音轨。以前两者绑在
 * 一次渲染里，于是换一首 BGM 要把整条片子重烧一遍——实测 12 分钟。
 * 拆开之后视频流直接 `-c:v copy`，只重编码音频：**同一条片子实测 9 秒**。
 *
 * 所以这个模块的全部意义就是那一句 `-c:v copy`。谁要是为了"顺手"
 * 在这里加个滤镜、改个分辨率，视频流就得重编码，80 倍的优势立刻归零。
 *
 * ── 音量与截断 ──────────────────────────────────────────────────────
 * `duration=first` 让成片长度跟着母带走：BGM 比配音短就循环
 * （-stream_loop -1），比配音长就在配音结束时截断。预览里那条
 * <audio loop> 的行为必须和这里一致，否则"所见即成片"就破了。
 */
export async function mixBgm (opts: {
  masterPath: string
  bgmPath: string
  /** BGM 相对配音的音量，0–1。配音始终满音量 */
  bgmVolume: number
  outPath: string
}): Promise<void> {
  /*
   * 【写临时文件再 rename】。直接写 outPath 的话，混音期间那个文件是
   * 半截的——而它正是用户此刻可能在播放/下载的那一份。线上真出过：
   * 拖了一下字幕高度触发重合，465MB 的成片当场变成 35MB 的残片，
   * 播不了也下不了。rename 在同一文件系统上是原子的，旧文件在新的
   * 完全就绪之前一直有效。
   */
  const partial = `${opts.outPath}.partial.mp4`

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', opts.masterPath,
    // BGM 比配音短就循环铺满。必须在 -i 之前
    '-stream_loop', '-1', '-i', opts.bgmPath,
    '-filter_complex',
    `[1:a]volume=${opts.bgmVolume}[bg];[0:a][bg]amix=inputs=2:duration=first[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy',              // ⚠️ 这一句是整个优化的全部，别动
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',   // 让浏览器不用下完整个文件就能起播
    partial,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, (err, _stdout, stderr) => {
        if (err) reject(new Error(`混音失败：${stderr || err.message}`))
        else resolve()
      })
    })
    await rename(partial, opts.outPath)
  } catch (e) {
    // 失败就把半成品收走，别留一个看起来像成片的残file
    await rm(partial, { force: true }).catch(() => {})
    throw e
  }
}
