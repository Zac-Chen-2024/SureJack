import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'

/**
 * 用 ffmpeg concat demuxer 拼接多段音频。
 *
 * 【重新编码，不用 -c copy】：各段是独立编码的 mp3，每段开头结尾都带
 * 编码器 padding。直接拷贝拼接会把这些 padding 留在接缝处，产生
 * 可听见的咔哒声。重编码一次只花几秒，远比成片里的杂音便宜。
 */
export async function concatAudio (inputs: string[], outPath: string): Promise<void> {
  if (inputs.length === 0) throw new Error('concatAudio: 输入为空')

  // concat 清单的转义规则：单引号要写成 '\'' 的形式。
  // 不转义的话，路径里一个单引号就能让 ffmpeg 把清单读错。
  const listPath = `${outPath}.concat.txt`
  const list = inputs
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n')
  await writeFile(listPath, list, 'utf8')

  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',          // 允许绝对路径
        '-i', listPath,
        '-c:a', 'libmp3lame',
        '-b:a', '96k',         // 与 synthesize 的输出码率一致
        outPath,
      ])
      let stderr = ''
      ff.stderr.on('data', (d) => { stderr += String(d) })
      ff.on('error', reject)
      ff.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`音频拼接失败（ffmpeg ${code}）：${stderr.slice(-500)}`))
      })
    })
  } finally {
    await unlink(listPath).catch(() => {})   // 清单是中间产物，失败也要清掉
  }
}
