import { describe, it, expect } from 'vitest'
import { filmFingerprint, type FilmFingerprintInput } from '../../src/compose/film.js'
import type { AspectPreset } from '../../src/types.js'

const ASPECT: AspectPreset = { name: '9:16', width: 1080, height: 1920 }

const BASE: FilmFingerprintInput = {
  aspect: ASPECT,
  durationMs: 60000,
  bgKey: 'plan:abc',
  ass: '[Script Info]\nDialogue: 他站在门口',
  voicePath: '/data/甲/p1/voice.mp3',
  bgmPath: '/data/library/4-BGM/雨.mp3',
  bgmVolume: 0.15,
}

/** 换一个字段，其余原样 */
function fpWith (patch: Partial<FilmFingerprintInput>): string {
  return filmFingerprint({ ...BASE, ...patch })
}

describe('成片指纹', () => {
  it('输入不变，指纹不变', () => {
    expect(filmFingerprint(BASE)).toBe(filmFingerprint({ ...BASE }))
  })

  it('换画幅 → 换指纹', () => {
    expect(fpWith({ aspect: { name: '1:1', width: 1080, height: 1080 } })).not.toBe(filmFingerprint(BASE))
  })

  it('换时长 → 换指纹', () => {
    expect(fpWith({ durationMs: 60001 })).not.toBe(filmFingerprint(BASE))
  })

  it('【排布变了】→ 换指纹。背景轨是成片的输入，它变了成片必须重来', () => {
    expect(fpWith({ bgKey: 'plan:def' })).not.toBe(filmFingerprint(BASE))
  })

  it('【字幕变了】→ 换指纹。ASS 全文把文案、时间轴、字幕高度、显示模式全含进去了', () => {
    expect(fpWith({ ass: BASE.ass + '\n' })).not.toBe(filmFingerprint(BASE))
  })

  it('换配音文件 → 换指纹', () => {
    expect(fpWith({ voicePath: '/data/甲/p1/voice2.mp3' })).not.toBe(filmFingerprint(BASE))
  })

  it('【换 BGM】→ 换指纹', () => {
    expect(fpWith({ bgmPath: '/data/library/4-BGM/雪.mp3' })).not.toBe(filmFingerprint(BASE))
  })

  it('【去掉 BGM】→ 换指纹', () => {
    expect(fpWith({ bgmPath: null })).not.toBe(filmFingerprint(BASE))
  })

  it('【调 BGM 音量】→ 换指纹', () => {
    expect(fpWith({ bgmVolume: 0.2 })).not.toBe(filmFingerprint(BASE))
  })

  it('字段之间不会串味：把一个字段的尾巴挪到下一个字段，指纹要不同', () => {
    const a = filmFingerprint({ ...BASE, voicePath: '甲', bgmPath: '乙' })
    const b = filmFingerprint({ ...BASE, voicePath: '甲乙', bgmPath: '' })
    expect(a).not.toBe(b)
  })
})
