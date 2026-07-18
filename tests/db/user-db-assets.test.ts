import { describe, it, expect, afterEach } from 'vitest'
import { openUserDb, type UserDb } from '../../src/db/user-db.js'

const LIST = ['测试素材甲']
let dbs: UserDb[] = []
afterEach(() => { dbs.forEach((d) => d.close()); dbs = [] })

function fresh (): UserDb {
  const db = openUserDb('测试素材甲', LIST)
  db.raw.exec('DELETE FROM export_jobs; DELETE FROM assets; DELETE FROM projects')
  dbs.push(db)
  return db
}

describe('assets', () => {
  it('新项目没有素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    expect(db.listAssets(p.id)).toEqual([])
  })

  it('加素材后能列出来，字段完整', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const a = db.addAsset({
      projectId: p.id, kind: 'video', path: '/data/x/video.mp4',
      originalName: '素材.mp4', size: 1024, durationMs: 26534, width: 1052, height: 596,
    })
    expect(a.id).toBeTruthy()
    expect(a.kind).toBe('video')
    expect(db.listAssets(p.id)).toHaveLength(1)
  })

  it('按 kind 过滤素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    db.addAsset({ projectId: p.id, kind: 'bgm', path: '/b.mp3', originalName: 'b', size: 1 })
    expect(db.listAssets(p.id, 'video')).toHaveLength(1)
    expect(db.listAssets(p.id, 'bgm')).toHaveLength(1)
  })

  it('删素材', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const a = db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    expect(db.deleteAsset(a.id)).toBe(true)
    expect(db.listAssets(p.id)).toHaveLength(0)
  })

  it('删项目时它的素材记录也没了（外键级联）', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.addAsset({ projectId: p.id, kind: 'video', path: '/a.mp4', originalName: 'a', size: 1 })
    db.deleteProject(p.id)
    expect(db.listAssets(p.id)).toHaveLength(0)
  })
})

describe('导出作业', () => {
  it('建作业后是 queued，进度 0', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    expect(job.status).toBe('queued')
    expect(job.progress).toBe(0)
  })

  it('更新进度与状态', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    db.updateJob(job.id, { status: 'running', progress: 42 })
    expect(db.getJob(job.id)?.progress).toBe(42)
    db.updateJob(job.id, { status: 'done', progress: 100, outputPath: '/out.mp4' })
    expect(db.getJob(job.id)?.outputPath).toBe('/out.mp4')
  })

  it('失败的作业记下错误信息', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const job = db.createJob(p.id)
    db.updateJob(job.id, { status: 'error', error: 'ffmpeg 退出码 1' })
    expect(db.getJob(job.id)?.error).toContain('ffmpeg')
  })

  it('latestJob 取该项目最近一次作业', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.createJob(p.id)
    const second = db.createJob(p.id)
    expect(db.latestJob(p.id)?.id).toBe(second.id)
  })
})

describe('项目的配音状态字段', () => {
  it('新项目 ttsState 是 none', () => {
    const db = fresh()
    expect(db.createProject('项目').ttsState).toBe('none')
  })

  it('能存配音结果并读回', () => {
    const db = fresh()
    const p = db.createProject('项目')
    const updated = db.updateProject(p.id, {
      ttsState: 'ready', ttsDurationMs: 184200,
      wordTimingsJson: JSON.stringify([{ text: '震惊', offsetMs: 50, durationMs: 588, isPunctuation: false }]),
    })
    expect(updated?.ttsState).toBe('ready')
    expect(updated?.ttsDurationMs).toBe(184200)
    expect(JSON.parse(updated!.wordTimingsJson!)).toHaveLength(1)
  })

  it('改文案后配音应被标记 stale —— 由调用方负责，这里验证字段能写', () => {
    const db = fresh()
    const p = db.createProject('项目')
    db.updateProject(p.id, { ttsState: 'ready' })
    db.updateProject(p.id, { scriptText: '新文案', ttsState: 'stale' })
    expect(db.getProject(p.id)?.ttsState).toBe('stale')
  })
})
