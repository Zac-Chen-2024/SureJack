import { describe, it, expect } from 'vitest'
import { assetDir, assetPathFor, isAllowedUpload } from '../../src/assets/storage.js'

const LIST = ['测试存储甲', '测试存储乙']

describe('assetDir —— 路径由会话身份拼出', () => {
  it('目录含用户名和项目 id', () => {
    const dir = assetDir('测试存储甲', LIST, 'proj-123')
    expect(dir).toContain('测试存储甲')
    expect(dir).toContain('proj-123')
  })

  it('名单外用户拿不到路径', () => {
    expect(() => assetDir('黑客', LIST, 'p')).toThrow()
  })

  it('两个用户的素材目录不同', () => {
    expect(assetDir('测试存储甲', LIST, 'p')).not.toBe(assetDir('测试存储乙', LIST, 'p'))
  })
})

describe('assetPathFor —— 防路径穿越', () => {
  it('正常文件名拼出目录下的路径', () => {
    const p = assetPathFor('测试存储甲', LIST, 'proj', 'video.mp4')
    expect(p).toContain('video.mp4')
  })

  it('文件名里的路径穿越被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', '../../../etc/passwd')).toThrow()
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', '..\\..\\windows')).toThrow()
  })

  it('projectId 里的穿越也被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, '../其他人', 'x.mp4')).toThrow()
  })

  it('文件名含斜杠被挡下', () => {
    expect(() => assetPathFor('测试存储甲', LIST, 'proj', 'sub/dir/x.mp4')).toThrow()
  })
})

describe('isAllowedUpload —— 早失败，不支持的格式当场拒绝', () => {
  it('接受常见视频格式作为背景视频', () => {
    expect(isAllowedUpload('video/mp4', 'a.mp4', 'video')).toBe(true)
    expect(isAllowedUpload('video/quicktime', 'a.mov', 'video')).toBe(true)
  })

  it('接受常见音频格式作为 BGM', () => {
    expect(isAllowedUpload('audio/mpeg', 'a.mp3', 'bgm')).toBe(true)
    expect(isAllowedUpload('audio/wav', 'a.wav', 'bgm')).toBe(true)
  })

  it('拒绝把音频当背景视频传', () => {
    expect(isAllowedUpload('audio/mpeg', 'a.mp3', 'video')).toBe(false)
  })

  it('拒绝可执行文件伪装', () => {
    expect(isAllowedUpload('application/x-executable', 'a.exe', 'video')).toBe(false)
    expect(isAllowedUpload('video/mp4', 'a.exe', 'video')).toBe(false)   // 扩展名也要对
  })
})
