import type { FastifyInstance } from 'fastify'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openUserDb, type Project } from '../db/user-db.js'
import { getSession, requireAuth } from '../auth/session.js'
import { assetDir } from '../assets/storage.js'
import { openLibraryDb } from '../library/library-db.js'
import { getLibraryItem } from '../library/scan.js'
import { libraryItemPath } from '../library/paths.js'
import {
  analyzeAudio, recommendBgmVolume, recommendVoiceGain,
  MUSIC_BELOW_VOICE_DB, type AudioStats,
} from './analyze.js'
import { TARGET_LUFS, TARGET_TP } from '../compose/mix.js'

/**
 * 音频面板要的全部数据：两条轨的波形、响度，以及和平台标准的对照。
 *
 * ── 预加载 ──────────────────────────────────────────────────────────
 * 量一条 10 分钟的音轨要几秒。**不能等用户点进这一屏才算**——那就是
 * 干等着转圈。所以配音一完成、音乐一选中，后台就先量好落库；
 * 这个接口绝大多数时候是【直接读库】，毫秒级返回。
 * 只有库里没有（老项目、刚换的音乐）才现算一次，算完顺手存下来。
 */

export interface TrackStats extends AudioStats {
  /** 音乐是哪一首。换了曲子就得重量 */
  libraryId?: string
}

export interface StoredStats {
  voice?: TrackStats
  bgm?: TrackStats
}

export function parseStats (json: string): StoredStats {
  if (json === '') return {}
  try {
    const o: unknown = JSON.parse(json)
    return (o !== null && typeof o === 'object') ? o as StoredStats : {}
  } catch {
    return {}
  }
}

/** 配音文件在哪儿。和 compose 那边保持一致 */
function voicePathOf (userName: string, whitelist: string[], projectId: string): string {
  return join(assetDir(userName, whitelist, projectId), 'voice.mp3')
}

/**
 * 把这个项目的两条音轨量好、存好。
 *
 * 【已经量过的不重复量】：配音只要文件没换就一直有效；音乐按 libraryId 比对，
 * 换了曲子才重量。量一次几秒，白量就是白等。
 */
export async function ensureAudioStats (
  userName: string, whitelist: string[], projectId: string,
  libraryDataDir: string,
  opts: { force?: boolean } = {},
): Promise<StoredStats> {
  const db = openUserDb(userName, whitelist)
  let project: Project | null
  try { project = db.getProject(projectId) } finally { db.close() }
  if (project === null) return {}

  const have = parseStats(project.audioStatsJson)
  const next: StoredStats = { ...have }
  let changed = false

  const vp = voicePathOf(userName, whitelist, projectId)
  if ((opts.force === true || have.voice === undefined) && existsSync(vp)) {
    try { next.voice = await analyzeAudio(vp); changed = true } catch { /* 量不出就先不给 */ }
  }

  const bgmId = project.bgmLibraryId
  if (bgmId === null || bgmId === '') {
    if (next.bgm !== undefined) { delete next.bgm; changed = true }
  } else if (opts.force === true || have.bgm?.libraryId !== bgmId) {
    const lib = openLibraryDb(libraryDataDir)
    let path: string | null = null
    try {
      const item = getLibraryItem(lib, bgmId)
      if (item !== null) path = libraryItemPath(libraryDataDir, item)
    } finally {
      lib.close()
    }
    if (path !== null && existsSync(path)) {
      try {
        next.bgm = { ...await analyzeAudio(path), libraryId: bgmId }
        changed = true
      } catch { /* 同上 */ }
    }
  }

  if (changed) {
    const db2 = openUserDb(userName, whitelist)
    try { db2.updateProject(projectId, { audioStatsJson: JSON.stringify(next) }) } finally { db2.close() }
  }
  return next
}

export function registerAudioRoutes (
  app: FastifyInstance, whitelist: string[], libraryDataDir: string,
): void {
  /**
   * 音频面板的数据源。
   *
   * 除了两条轨的波形和响度，还回【对照用的三个数】——用户要的就是这个：
   *   · 平台标准（-14 LUFS）：流媒体的通用基准
   *   · 当前各轨实测
   *   · 建议值：音乐压在人声之下 10 分贝，这是行业惯例
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/audio', { preHandler: requireAuth }, async (req, reply) => {
      const name = getSession(req)!
      const db = openUserDb(name, whitelist)
      let project: Project | null
      try { project = db.getProject(req.params.id) } finally { db.close() }
      if (project === null) return reply.code(404).send({ error: '项目不存在' })

      const stats = await ensureAudioStats(name, whitelist, req.params.id, libraryDataDir)
      const vl = stats.voice?.lufs
      const bl = stats.bgm?.lufs

      return {
        voice: stats.voice ?? null,
        bgm: stats.bgm ?? null,
        /** 当前设置 */
        voiceGain: project.voiceGain,
        bgmVolume: project.bgmVolume,
        /** 平台基准。成片最后会被归一化到这里 */
        target: { lufs: TARGET_LUFS, truePeak: TARGET_TP },
        /** 建议：音乐压在人声之下 MUSIC_BELOW_VOICE_DB 分贝 */
        recommended: {
          voiceGain: vl === undefined ? 1 : recommendVoiceGain(vl),
          bgmVolume: (vl === undefined || bl === undefined) ? 0.15 : recommendBgmVolume(vl, bl),
          musicBelowVoiceDb: MUSIC_BELOW_VOICE_DB,
        },
      }
    })
}
