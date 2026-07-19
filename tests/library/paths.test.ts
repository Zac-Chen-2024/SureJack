import { describe, it, expect } from 'vitest'
import { basename, resolve } from 'node:path'
import { BUCKETS, isBucket, bucketDir, libraryRoot } from '../../src/library/paths.js'

const DATA = '/tmp/sj-test-data'

describe('bucketDir', () => {
  it('四个桶都被认可', () => {
    for (const b of BUCKETS) expect(isBucket(b)).toBe(true)
  })

  it('桶目录在全局 library 之下，不含任何用户名', () => {
    expect(bucketDir(DATA, '1-开头')).toBe(resolve(DATA, 'library', '1-开头'))
  })

  it('未知桶名被拒绝', () => {
    expect(() => bucketDir(DATA, '随便一个桶')).toThrow(/桶/)
  })

  /*
   * 这组用例守的是【唯一】的穿越防线。素材库不经过 userDbDir，
   * 一旦 isBucket 被绕过，就直接是任意路径读写。
   *
   * 注意断言必须是 .toThrow(/桶/) —— 写成 expect(fn).toBe(true) 之类
   * 是在断言「函数等于 true」，测试要么恒假要么恒真，防线等于没测。
   */
  it('桶名目录穿越被拒绝', () => {
    const evil = [
      '../../../etc', '..', '.', '1-开头/../../..', '/etc/passwd',
      '1-开头/../背景音乐',           // 看似停在库内，也不许
      '..%2f..%2fetc',                // URL 编码残留
      '1-开头\\0/etc',                // 反斜杠残留
      '1-开头\0/etc',                 // 真空字节截断
      '１-开头',                      // 全角冒充
      '1-开头 ',                      // 尾部空格
      '',                             // 空串
    ]
    for (const e of evil) {
      expect(() => bucketDir(DATA, e), `${e} 应被拒绝`).toThrow(/桶/)
    }
  })

  it('无论输入什么，结果都不逃出 library 根目录', () => {
    const root = resolve(libraryRoot(DATA))
    for (const b of BUCKETS) {
      expect(resolve(bucketDir(DATA, b)).startsWith(root + '/')).toBe(true)
    }
  })

  /*
   * 以下为计划之外的独立验证。
   */

  it('isBucket 对穿越串一律返回 false（白名单本身就是闸，不只是 bucketDir 包了一层）', () => {
    const evil = ['../../../etc', '..', '', '1-开头/../背景音乐', '１-开头', '1-开头 ']
    expect(evil.map((e) => isBucket(e))).toEqual(evil.map(() => false))
  })

  it('桶目录的最后一段就是桶名本身，没有被清洗或改写', () => {
    expect(BUCKETS.map((b) => basename(bucketDir(DATA, b)))).toEqual([...BUCKETS])
  })

  it('library 根目录里不出现任何用户名', () => {
    // 素材库是全局的：无论谁调用，路径都一样，签名里根本没有身份参数
    expect(libraryRoot(DATA)).toBe(resolve(DATA, 'library'))
    for (const name of ['陈梓昂', '黄诗婕']) {
      expect(libraryRoot(DATA).includes(name)).toBe(false)
    }
  })

  it('桶名恰好是四个，且互不重复', () => {
    expect(BUCKETS.length).toBe(4)
    expect(new Set(BUCKETS).size).toBe(4)
  })
})
