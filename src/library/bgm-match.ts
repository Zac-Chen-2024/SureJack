/**
 * 按文案内容自动挑背景音乐。
 *
 * 素材库里 9 首 BGM 的文件名自带标签（`一笑倾城 现言 甜文.wav`），
 * 这里把文案分类到同一套标签上，再找匹配度最高的那首。
 *
 * ⚠️【绝不用单字关键词】。第一版用了「亲」「笑」「暖」这类单字，结果
 * 豪门那篇的「甜文」得分虚高三倍——38 个「亲」里有 26 个是「亲爸」
 * 「亲妈」「亲生」，一个亲吻都没有。中文里单字在复合词中出现的频率
 * 远高于它本身的语义，用单字统计等于在数噪声。
 *
 * 所以下面的词表**只收双字以上的词**，宁可漏也不要误判。
 */

/** 时代背景 */
export type Era = '现言' | '古言'
/** 情绪基调 */
export type Tone = '甜文' | '虐文' | '爽文'

export interface ScriptGenre {
  era: Era
  tone: Tone
  /** 各维度的原始命中次数，供调试和界面解释「为什么选了这首」 */
  scores: Record<string, number>
}

const TERMS: Record<string, readonly string[]> = {
  古言: ['皇上', '王爷', '娘娘', '公子', '丞相', '将军', '太子', '圣旨',
    '侯府', '本宫', '臣妾', '姑娘', '相公', '大人', '奴婢', '王妃'],
  现言: ['手机', '微信', '电话', '公司', '老板', '豪门', '总裁', '大学',
    '网恋', '医院', '短信', '朋友圈', '微博', '上班', '房子', '开车'],
  甜文: ['喜欢', '心动', '温柔', '告白', '撒娇', '脸红', '亲吻', '牵手',
    '宠着', '哄我', '抱住', '心疼我', '陪我', '守护'],
  虐文: ['眼泪', '背叛', '离开我', '失去', '绝症', '车祸', '流产', '自杀',
    '恨我', '哭着', '死了', '骗我', '抛弃', '痛苦'],
  爽文: ['打脸', '逆袭', '复仇', '翻身', '解气', '活该', '报应', '后悔',
    '跪下', '算计', '扇了', '甩了'],
}

/** 数某一组词在文本里的总命中次数 */
function score (text: string, terms: readonly string[]): number {
  let n = 0
  for (const t of terms) {
    // split 比循环 indexOf 简洁，且不会漏重叠外的重复
    n += text.split(t).length - 1
  }
  return n
}

/**
 * 给文案分类。
 *
 * 时代默认现言——营销号短视频绝大多数是现代背景，古言要有明确证据
 * 才判；否则一个「大人」就能把现代剧判成古装。
 *
 * 基调取三者最高；全为 0 时默认甜文（最百搭，且库里有「非虐文通用」兜底）。
 */
export function classifyScript (text: string): ScriptGenre {
  const scores: Record<string, number> = {}
  for (const [k, terms] of Object.entries(TERMS)) scores[k] = score(text, terms)

  const gu = scores['古言'] ?? 0
  const xian = scores['现言'] ?? 0
  // 古言要【明显】压过现言才判古言：证据不足时判现代，错得更轻
  const era: Era = gu > xian * 1.5 && gu >= 3 ? '古言' : '现言'

  const toneEntries: [Tone, number][] = [
    ['甜文', scores['甜文'] ?? 0],
    ['虐文', scores['虐文'] ?? 0],
    ['爽文', scores['爽文'] ?? 0],
  ]
  toneEntries.sort((a, b) => b[1] - a[1])
  const top = toneEntries[0]
  const tone: Tone = top && top[1] > 0 ? top[0] : '甜文'

  return { era, tone, scores }
}

/** 一首 BGM 从文件名解出来的标签 */
export interface BgmTags {
  title: string
  era: Era | null
  /** 正向基调：这首曲子适合的 */
  tones: Tone[]
  /** 反向基调：文件名里写了「非X」，明确不适合 */
  notTones: Tone[]
  /** 万金油，没有精确匹配时可以兜底 */
  generic: boolean
}

/**
 * 从文件名里剥出标签。
 *
 * ⚠️ 真实文件名比"曲名 + 空格分隔的标签"这个假设脏得多。库里 9 首实际是：
 *
 *   一笑倾城 现言 甜文.wav      ← 规规矩矩
 *   虐心回忆文.wav              ← 【没有空格】，按空格切会解出零个标签
 *   非虐文通用.wav              ← 含「虐文」，但被「非」否定了，是【反向】标签
 *   重生非甜文通用(1).mp3       ← 同上，还带个 (1) 后缀
 *
 * 所以不按空格切，而是在整个文件名里扫已知标签词，并且**先处理否定**：
 * 「非虐文」必须在「虐文」之前匹配掉，否则会把反向标签读成正向，
 * 给一篇虐文配上一首明确标着"非虐文"的曲子。
 */
export function tagsOf (filename: string): BgmTags {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/\(\d+\)$/, '').trim()

  const notTones: Tone[] = []
  const tones: Tone[] = []
  // 【先否定后肯定】：扫到「非甜文」就把它从待匹配文本里挖掉，
  // 免得后面那轮又把「甜文」当成正向标签数一遍
  let rest = stem
  for (const t of ['甜文', '虐文', '爽文'] as Tone[]) {
    if (rest.includes(`非${t}`)) {
      notTones.push(t)
      rest = rest.split(`非${t}`).join('')
    }
  }
  for (const t of ['甜文', '虐文', '爽文'] as Tone[]) {
    if (rest.includes(t)) tones.push(t)
  }
  // 「虐心」「甜宠」这类没写成规范标签的：按语义补上
  if (!tones.includes('虐文') && !notTones.includes('虐文') && /虐心|虐恋/.test(rest)) {
    tones.push('虐文')
  }

  const era: Era | null = rest.includes('古言') ? '古言'
    : rest.includes('现言') ? '现言' : null

  // 曲名：首个空格前，没空格就是整个 stem 去掉标签词后的残余
  const title = stem.split(/\s+/)[0] ?? stem

  return { title, era, tones, notTones, generic: /通用/.test(stem) }
}

export interface BgmCandidate {
  id: string
  filename: string
}

/**
 * 给文案挑一首 BGM。
 *
 * 打分：标签命中时代 +2，命中基调 +3（基调比时代更影响听感），
 * 「通用」类兜底 +1。同分时取文件名靠前的，保证**确定性**——
 * 同一篇文案每次挑出来必须是同一首，否则用户重新导出配乐就变了。
 */
export function pickBgm (
  text: string, candidates: readonly BgmCandidate[],
): { chosen: BgmCandidate | null; genre: ScriptGenre; why: string } {
  const genre = classifyScript(text)
  if (candidates.length === 0) return { chosen: null, genre, why: '素材库里没有背景音乐' }

  const ranked = [...candidates]
    // 先按文件名排序，保证同分时的取舍是【确定性】的——
    // 同一篇文案每次挑出来必须是同一首，否则重新导出配乐就变了
    .sort((a, b) => a.filename.localeCompare(b.filename, 'zh'))
    .map((c) => {
      const t = tagsOf(c.filename)
      let s = 0
      const hit: string[] = []

      // 明确标着「非X」而文案正是 X：直接判死，绝不能选
      if (t.notTones.includes(genre.tone)) return { c, s: -100, hit: [`非${genre.tone}`] }

      if (t.tones.includes(genre.tone)) { s += 3; hit.push(genre.tone) }
      if (t.era === genre.era) { s += 2; hit.push(genre.era) }
      // 【时代冲突要扣分】：曲子明确标着另一个时代。不扣的话，
      // 一首「古言 虐文」会靠基调分压过没有时代标签的「虐心」，
      // 给现代剧配上古风曲——这正是第一版犯的错
      else if (t.era !== null) { s -= 2; hit.push(`✗${t.era}`) }
      if (t.generic) { s += 1; hit.push('通用') }

      return { c, s, hit }
    })
    .sort((a, b) => b.s - a.s)

  const best = ranked[0]
  if (!best || best.s <= 0) {
    // 没有正分：说清是兜底不是匹配，别让用户以为系统"选"了什么
    const safe = ranked.find((r) => r.s > -100)?.c ?? null
    return { chosen: safe, genre, why: `没有曲子匹配 ${genre.era}/${genre.tone}，取了兜底` }
  }
  return {
    chosen: best.c,
    genre,
    why: `文案判为 ${genre.era}/${genre.tone}，命中 ${best.hit.join('+')}`,
  }
}
