/**
 * 【自动补满开头】。给一堆候选素材和"还差多少毫秒",挑出一组把它填满。
 *
 * ── 好在哪儿 ────────────────────────────────────────────────────────
 * 开头段是"铺满就停"的:跨过边界的那一段会被【截短】。所以补法不同,
 * 观感差很多——
 *
 *   还差 15 秒,手上有 5/6/7/9 秒的片子:
 *     · 9+6  → 正好 15 秒,**一刀都不用切**
 *     · 7+9  → 16 秒,最后那段被切掉 1 秒(还行)
 *     · 7+6+5 → 18 秒,最后那段只播 2 秒,一晃而过,很碎
 *
 * 用户的原话:"宁愿选 7+9 而不选 7+6+5"。也就是**先让超出的部分最少**
 * (最好是 0,一刀不切),超出一样多时**用更少的片子**。
 *
 * ── 为什么不用贪心 ──────────────────────────────────────────────────
 * 贪心("先拿能整段放下的最长的,最后拿一个刚好够的")大多数时候对,
 * 但会在这种地方翻车:还差 15,手上有 16/8/7 —— 贪心直接拿 16(切掉 1 秒),
 * 而 8+7 正好 15、**一刀不切**。既然要"尽可能不剪断",就该真的把最优解算出来。
 *
 * ── 怎么算 ──────────────────────────────────────────────────────────
 * 0/1 背包。时间量化到 100 毫秒(3 帧,肉眼分辨不出),上界只到
 * "还差的量 + 最长的一段"——再往上都是白白超出更多,不可能更优。
 * 68 段素材 × 一千多个格子,几毫秒的事。
 */

export interface FillItem {
  id: string
  durationMs: number
}

/** 时间量化的粒度。100 毫秒 = 3 帧,肉眼分辨不出,而格子数少一个数量级 */
const QUANTUM_MS = 100

/**
 * 挑一组素材把 `remainingMs` 填满。
 *
 * @returns 选中的素材,**最长的那一段排在最后**——被截短的永远是最后一段,
 *          让它落在最长的那一段上,切掉的比例最小。
 *          填不满(素材加起来都不够)就返回能给的最多的一组;
 *          调用方自己判断够不够,这里不抛。
 */
export function fillToTarget (
  pool: readonly FillItem[], remainingMs: number,
): FillItem[] {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return []
  const items = pool.filter((it) => Number.isFinite(it.durationMs) && it.durationMs > 0)
  if (items.length === 0) return []

  const need = Math.ceil(remainingMs / QUANTUM_MS)
  const q = items.map((it) => Math.max(1, Math.round(it.durationMs / QUANTUM_MS)))
  const longest = Math.max(...q)
  /*
   * 上界 = 需要的量 + 最长的一段。超过这个的组合必然比某个"刚好跨过去"的
   * 组合超出更多,不可能是最优解——砍掉它们只是省格子,不影响结果。
   */
  const cap = need + longest

  /** dp[s] = 凑出【正好 s 格】最少要几段;Infinity = 凑不出 */
  const dp = new Float64Array(cap + 1).fill(Infinity)
  dp[0] = 0
  /** 回溯用:凑出 s 格时最后放进去的是第几段 */
  const from = new Int32Array(cap + 1).fill(-1)
  /** 凑出 s 格时的上一个状态 */
  const prev = new Int32Array(cap + 1).fill(-1)

  for (const [i, d] of q.entries()) {
    // 【逆序】——0/1 背包,保证每段最多用一次
    for (let s = cap; s >= d; s--) {
      const cand = dp[s - d]! + 1
      if (cand < dp[s]!) {
        dp[s] = cand
        from[s] = i
        prev[s] = s - d
      }
    }
  }

  /*
   * 在所有"够长"的组合里挑:**先比超出多少,再比用了几段**。
   * 一个都够不上(素材总长不够)时退回"能凑到的最大值",让调用方去提示还差多少。
   */
  let best = -1
  // s 从小往大扫，第一个凑得出来的就是【超出最少】的那个；
  // 同一个 s 之下，dp[s] 本来就已经是"最少几段"，段数这条自动满足。
  for (let s = need; s <= cap; s++) {
    if (Number.isFinite(dp[s]!)) { best = s; break }
  }
  if (best < 0) {
    for (let s = cap; s >= 1; s--) {
      if (Number.isFinite(dp[s]!)) { best = s; break }
    }
  }
  if (best < 0) return []

  const chosen: FillItem[] = []
  for (let s = best; s > 0;) {
    const i = from[s]!
    if (i < 0) break
    chosen.push(items[i]!)
    s = prev[s]!
  }
  /*
   * 【最长的排最后】。被截短的永远是最后一段(开头段铺满就停),
   * 把它落在最长的那一段上,切掉的比例最小、最不像"被砍了一刀"。
   */
  chosen.sort((a, b) => a.durationMs - b.durationMs)
  return chosen
}
