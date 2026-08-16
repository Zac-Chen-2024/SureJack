import { openUserDb } from '../db/user-db.js'
import { openLibraryDb } from '../library/library-db.js'
import { listBucket } from '../library/scan.js'
import { parseOpeningPick, OPENING_BUCKET } from '../library/background.js'
import { fillToTarget } from '../library/auto-fill.js'
import { DEFAULT_RATIO } from '../compose/plan.js'
import { headBoundary } from '../subtitles/head-boundary.js'
import { deriveSubtitleLines } from '../subtitles/project-ass.js'

/**
 * 【配音一完成就把开头段的边界算好写死】。
 *
 * 为「重选开头」服务：只要这个分界永远落在同一时刻，后半段就能原样复用，
 * 用户重选开头时只重烧那一两分钟，而不是整条 14 分钟。
 *
 * ⚠️【必须在这一刻算，而且只算这一次】。词级时间戳是配音的产物，
 * 在这一刻定死、之后永不改变——边界锚在它上面才是不可动摇的。
 * 换成"每次现算"的话，比例常数以后一调，老项目的边界就跟着漂，
 * 盘上那份后半段立刻对不上新时间轴。
 *
 * ⚠️【同步做，不能异步】。它必须在合成入队【之前】写进库：排布要用它来
 * 定开头段长度，晚一步的话这一次烧的就是没有定长开头的版本，
 * 而用户看到的却是"支持重选开头"。
 *
 * 算不出来（字幕太少、末尾大段静音）就留 null——那只意味着这条片子
 * 不支持重选开头，不该让它连烧都烧不了。
 *
 * ── 为什么可以先于语义切分算 ──────────────────────────────────────
 * 这一刻断点还没落库，拿到的是逗号切出来的原始句。之后 planSubtitleCuts
 * 会把超过 14 字的句子【在句子内部】再切开——切出来的最后一片仍然结束在
 * 原来那一句的句尾。所以边界永远还是某一句的句尾，句末对齐不会被破坏。
 * （代价只是切分之后可能出现一个更早的句尾也 ≥ 目标，于是开头比"最紧"的
 * 那个选择长零点几秒——无所谓，反正取的就是大的那一边。）
 */
export function settleAfterVoice (
  userName: string, whitelist: string[], projectId: string, libraryDataDir: string,
): void {
  try {
    const db = openUserDb(userName, whitelist)
    try {
      const project = db.getProject(projectId)
      if (!project) return

      /*
       * 【算这一份配音【当下】该有的分界】。
       *
       * · 自备 SRT(line 模式)没有"开头桶"的概念 → null
       * · 字幕太少 / 末尾大段静音 → null（这条片子不支持重选开头，
       *   但绝不该因此连烧都烧不了）
       */
      const b = project.subtitleMode === 'line'
        ? null
        : headBoundary(deriveSubtitleLines(project), project.ttsDurationMs ?? 0)
      const boundaryMs = b?.endMs ?? null

      /*
       * ⚠️【算出什么就写什么，包括写回 null】。这里【曾经】写着
       * "已经定过，终身不改"——那是错的，而且是个活的洞：
       *
       * · 改文案 → stale → 重新生成配音 → 早退 → 边界还锚在【上一份配音】上。
       *   新配音总长变了，开头比例就不再是 15%，静默变形；
       *   新配音要是短过旧边界，排布那边 `hb < totalMs` 判假，
       *   **悄悄退回不定长逻辑**，这条片子从此失去重选开头能力而没人知道。
       * · 先做文本配音(有边界)、后来改成自备音频(line) → 早退 → 留着一个
       *   过期的边界，而自备那条路根本没有开头桶。
       *
       * 当初写"终身不改"是为了让后半段能复用；但**重新配音时后半段本来
       * 就作废了**（新词级时间戳 → 新 ASS → tail 指纹变 → 整条重烧），
       * 那条理由在这里不成立。
       *
       * 不变量：**head_boundary_ms 必须和当前这份 wordTimings 同源**。
       * 所以凡是写 tts_duration_ms 的地方（主片配音、续集配音、自备音频
       * adopt-srt，共三处）都要走这个函数。
       */
      db.updateProject(projectId, {
        headBoundaryMs: boundaryMs,
        /*
         * 【比例只在第一次写，之后不动】。它存的是"这条片子按什么比例排"，
         * 不存的话以后一调常量，盘上每一条片子的排布就跟着变、母带指纹变、
         * 开机补合把它们全部重烧一遍。
         *
         * 而它【不该跟着重配音churn】：定长开头下 ratio[0] 根本用不上
         * （开头长度由分界直接给），真正起作用的只有常规:跑酷那一档，
         * 改它等于无缘无故换掉一条她可能已经认可的排布风格。
         */
        ...(project.layoutRatioJson === null && boundaryMs !== null
          ? { layoutRatioJson: JSON.stringify(DEFAULT_RATIO) }
          : {}),
      })
      if (boundaryMs === null) return

      /*
       * ⚠️【已经敲定过开头的，这一刻要把清单补齐】。
       *
       * "挑够了吗"那道闸是按 head_boundary_ms 判的，而这个数【现在才有】。
       * 所以只要作者是在配音出结果【之前】按的确认，那道闸就形同虚设——
       * 线上真发生过：配音第一次失败(Azure 挂了)，她挑了 57 秒就确认了，
       * 后来配音成功、边界算出来 81 秒，这条片子从此再也合不出来
       * （排布要求正好铺满，而 settled 之后她回不到挑选界面，自己救不了）。
       *
       * 边界诞生的这一刻，正是唯一能把两者对齐的时机。补齐用的是和
       * 「自动」按钮同一套算法，补完写回库里——库里那份才是排布的依据。
       *
       * 【只补 settled 的】。还停在 pending 的说明作者马上要去挑，
       * 替他填上等于抢答。
       */
      if (project.openingState === 'settled') {
        const pick = parseOpeningPick(project.openingPickJson)
        const lib = openLibraryDb(libraryDataDir)
        try {
          const all = listBucket(lib, OPENING_BUCKET)
          const byId = new Map(all.map((it) => [it.id, it]))
          const have = pick.reduce((sum, id) => sum + (byId.get(id)?.durationMs ?? 0), 0)
          if (have < boundaryMs) {
            const used = new Set(pick)
            const rest = all.filter((it) => !used.has(it.id) && it.durationMs > 0)
            const added = fillToTarget(rest, boundaryMs - have)
            if (added.length > 0) {
              db.updateProject(projectId, {
                openingPickJson: JSON.stringify([...pick, ...added.map((x) => x.id)]),
              })
            }
          }
        } finally { lib.close() }
      }
    } finally { db.close() }
  } catch { /* 算不出边界不该影响配音本身已经成功这件事 */ }
}
