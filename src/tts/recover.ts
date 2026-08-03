import { openUserDb } from '../db/user-db.js'

/**
 * 开机复位那些【卡在"配音生成中"】的项目。
 *
 * ⚠️【为什么必须有这一道】：配音是在进程里跑的一个长任务（十几分钟），
 * 状态先写 'generating'、跑完再写 'ready'。进程中途没了——部署重启、
 * 崩溃、OOM——那一行就永远停在 'generating'。
 *
 * 于是界面一直转圈，而【根本没有任何进程在做这件事】。用户看到的是
 * "还在生成"，事实是"永远不会好"，他能等一整天也等不到，也不会想到去重试。
 * 线上真出过：一次部署重启正好压在配音中间。
 *
 * 复位成 'error' 而不是 'none'：
 *   · 'none' 会让它看起来像一条【还没配过音的草稿】，而它其实有半截产物
 *     （被杀在半路的 voice.mp3，实测只写了 26 秒、按字数该有 441 秒）。
 *   · 'error' 在界面上是"未完成"，编辑器里就有重试入口——把"该重来一次"
 *     这件事明说出来。
 *
 * ⚠️【不自动重跑】。配音是这条流水线上唯一按量计费的一步；万一部署进了
 * 崩溃循环，自动重跑会在每次开机时烧一遍配额。宁可让用户点一下。
 */
export function resetStuckVoices (whitelist: string[]): Array<{ user: string; name: string; id: string }> {
  const reset: Array<{ user: string; name: string; id: string }> = []
  for (const user of whitelist) {
    const db = openUserDb(user, whitelist)
    try {
      for (const p of db.listProjects()) {
        if (p.ttsState !== 'generating') continue
        db.updateProject(p.id, { ttsState: 'error' })
        reset.push({ user, name: p.name, id: p.id })
      }
    } finally {
      db.close()
    }
  }
  return reset
}
