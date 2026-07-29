/**
 * 配音音色与韵律参数的【唯一真相源】。
 *
 * ⚠️ 音色 id 全部核对过 Azure `voices/list` 接口（zh-CN 60 个里挑的）——
 * 无效 id 会让合成直接失败、且失败信息很难看懂。改这个清单时【必须再核一遍】：
 *   curl -H "Ocp-Apim-Subscription-Key: $KEY" \
 *     https://$REGION.tts.speech.microsoft.com/cognitiveservices/voices/list
 * 上一版这里写了 zh-CN-XiaoxuanNeural，它根本不存在，是核对时才逮住的。
 *
 * 前端不能 import 这个文件（会把 better-sqlite3 之类拖进浏览器包），
 * 所以 web/src/store/projects.ts 里另存一份等价清单，靠测试钉死两边一致。
 */

export interface VoiceOption {
  id: string
  /** 界面上显示的名字 */
  label: string
  gender: 'female' | 'male'
}

/**
 * 下拉里列的音色。挑的是营销号最常用、辨识度高的：
 * 5 个女声 + 5 个男声，覆盖甜/稳/少年/成熟几种调性。
 */
export const VOICES: VoiceOption[] = [
  { id: 'zh-CN-XiaochenNeural', label: '晓辰（女·自然）', gender: 'female' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温柔）', gender: 'female' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女·活泼）', gender: 'female' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵（女·温暖）', gender: 'female' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨（女·多变）', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男·少年）', gender: 'male' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男·播报）', gender: 'male' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男·浑厚）', gender: 'male' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男·阳光）', gender: 'male' },
  { id: 'zh-CN-YunyeNeural', label: '云野（男·成熟）', gender: 'male' },
]

/** 新建【文本】项目的默认音色。老项目不受它影响（见 LEGACY_VOICE） */
export const DEFAULT_VOICE = 'zh-CN-XiaochenNeural'

/**
 * 加这个功能【之前】所有项目隐含用的音色。
 *
 * 用途只有一个：数据库新列的迁移默认值、以及母带指纹的「老默认」判定，
 * 都锚定到它——这样已存在的项目回填出来就是它们的事实值，指纹一个字节
 * 都不变，开机补合不会把它们重烧一遍。绝不能把它改成 DEFAULT_VOICE。
 */
export const LEGACY_VOICE = 'zh-CN-XiaoxiaoNeural'

/**
 * 韵律参数的范围与默认。都用【整数百分比偏移】，0 = 不改。
 *
 * - rate 允许到 +100 是因为营销号常要「快嘴」；下限 -50 再慢就不像人说话了。
 * - volume/pitch 收窄到 ±50：再大 Azure 会出现破音/怪调，且这类视频用不上。
 * - ⚠️ 这些是 SSML <prosody> 的相对值，和「BGM 音量平衡」（配音 vs 背景乐）
 *   完全是两码事，别搞混。
 */
export const RATE_RANGE = { min: -50, max: 100, default: 0 } as const
export const VOLUME_RANGE = { min: -50, max: 50, default: 0 } as const
export const PITCH_RANGE = { min: -50, max: 50, default: 0 } as const

/**
 * 【新建文本项目的默认语速】+75%。
 *
 * ⚠️ 这和 RATE_RANGE.default（0）是两回事，别混：
 *   - RATE_RANGE.default = 0 是「中性值」——迁移回填、母带指纹的老默认判定
 *     都锚定它，绝不能改（改了老项目全重烧）。
 *   - DEFAULT_VOICE_RATE = 75 只在 createProject 给【新】项目用。
 * 就像 DEFAULT_VOICE（晓辰）之于 LEGACY_VOICE（晓晓）——新老分开。
 *
 * 为什么是 75：晓辰原生语速偏慢，一篇 4500 字要念 13 分钟；实测 +86% 追平
 * 真人录的 9.8 分，+75% 略从容一点、约 10 分，是个更稳的起点。用户可再调。
 */
export const DEFAULT_VOICE_RATE = 75

export interface VoiceParams {
  voice: string
  rate: number
  volume: number
  pitch: number
}

/** 老默认那一组值。母带指纹据此判断「要不要把配音参数并进去」 */
export const LEGACY_PARAMS: VoiceParams = {
  voice: LEGACY_VOICE,
  rate: RATE_RANGE.default,
  volume: VOLUME_RANGE.default,
  pitch: PITCH_RANGE.default,
}

export function isAllowedVoice (id: unknown): id is string {
  return typeof id === 'string' && VOICES.some((v) => v.id === id)
}

function clampInt (v: unknown, range: { min: number; max: number; default: number }): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return range.default
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

/** 把外来的韵律数值钳进合法范围。音色不在这里校验（走 isAllowedVoice） */
export function clampRate (v: unknown): number { return clampInt(v, RATE_RANGE) }
export function clampVolume (v: unknown): number { return clampInt(v, VOLUME_RANGE) }
export function clampPitch (v: unknown): number { return clampInt(v, PITCH_RANGE) }

/**
 * 这组参数是不是「老默认」。是的话，母带指纹就当它不存在——见 film.ts。
 * 用它而不是散落各处比较，避免哪天加了参数忘了同步判定。
 */
export function isLegacyParams (p: VoiceParams): boolean {
  return p.voice === LEGACY_PARAMS.voice
    && p.rate === LEGACY_PARAMS.rate
    && p.volume === LEGACY_PARAMS.volume
    && p.pitch === LEGACY_PARAMS.pitch
}

/** 把百分比偏移格式化成 SSML 要的 "+30%" / "-10%" / "+0%" */
export function pct (n: number): string {
  return `${n >= 0 ? '+' : ''}${n}%`
}
