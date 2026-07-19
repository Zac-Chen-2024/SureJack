import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStamp, reusableOutput, writeStamp } from '../../src/compose/stamp.js'

const FP = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const STAMP = 'export.json'
const OUT = 'export.mp4'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sj-stamp-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function putOutput (bytes = '不是真的 mp4，但字节数大于 0'): Promise<void> {
  await writeFile(join(dir, OUT), bytes)
}

describe('指纹旁挂文件 —— 读', () => {
  it('写进去什么就读出什么', async () => {
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'error', error: '炸了', jobId: 'j1' })
    expect(await readStamp(dir, STAMP)).toEqual({
      fingerprint: FP, status: 'error', error: '炸了', jobId: 'j1',
    })
  })

  it('文件不存在时回 null，不抛', async () => {
    expect(await readStamp(dir, STAMP)).toBe(null)
  })

  it('内容不是合法 JSON 时回 null，不抛', async () => {
    await writeFile(join(dir, STAMP), '{ 半个 json')
    expect(await readStamp(dir, STAMP)).toBe(null)
  })

  it('没有 fingerprint 字段的对象当成读不出来', async () => {
    await writeFile(join(dir, STAMP), JSON.stringify({ status: 'done' }))
    expect(await readStamp(dir, STAMP)).toBe(null)
  })

  it('认不出来的 status 一律丢掉，绝不当成 done', async () => {
    await writeFile(join(dir, STAMP), JSON.stringify({ fingerprint: FP, status: '完事了' }))
    expect(await readStamp(dir, STAMP)).toEqual({ fingerprint: FP })
  })
})

describe('产物还能不能用', () => {
  it('指纹对得上、status=done、文件非空 → 给路径', async () => {
    await putOutput()
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'done' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(join(dir, OUT))
  })

  it('【兼容老格式】只有 fingerprint 一个字段的也算 done', async () => {
    await putOutput()
    await writeStamp(dir, STAMP, { fingerprint: FP })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(join(dir, OUT))
  })

  it('指纹对不上 → null', async () => {
    await putOutput()
    await writeStamp(dir, STAMP, { fingerprint: OTHER, status: 'done' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(null)
  })

  it('status=building 说明只做到一半 → null', async () => {
    await putOutput()
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'building' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(null)
  })

  it('status=error → null', async () => {
    await putOutput()
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'error', error: '炸了' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(null)
  })

  it('0 字节的产物 → null（拼到一半被杀会留下这种）', async () => {
    await putOutput('')
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'done' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(null)
  })

  it('指纹对得上但产物文件不在 → null', async () => {
    await writeStamp(dir, STAMP, { fingerprint: FP, status: 'done' })
    expect(await reusableOutput(dir, STAMP, OUT, FP)).toBe(null)
  })
})
