import { join, resolve } from 'node:path'

/**
 * 四个素材桶。名字对应用户素材包里的目录结构（1-/2-/3- 编号是他自己的分类）。
 *
 * 这同时是【白名单】，而且是【唯一】的一道闸：素材库是全局的、
 * 不经过 userDbDir()，所以没有第二层路径校验兜底。桶名来自
 * /api/library/:bucket 这个路由参数，是纯粹的外部输入。
 *
 * 用【全等匹配】而不是任何形式的清洗或过滤——不试图把脏输入
 * 修正成干净的，只回答「它是不是这四个字符串之一」。
 */
export const BUCKETS = ['1-开头', '2-常规', '3-地铁跑酷', '背景音乐'] as const
export type Bucket = typeof BUCKETS[number]

export function isBucket (s: string): s is Bucket {
  return (BUCKETS as readonly string[]).includes(s)
}

/** 全局素材库根目录。全站一份，不属于任何用户。 */
export function libraryRoot (dataDir: string): string {
  return resolve(dataDir, 'library')
}

/**
 * 某个桶的目录。
 *
 * 【先查白名单再拼路径】。先拼后查的话，'../../etc' 这样的值在被
 * 拒绝之前就已经参与了路径构造——而这里没有第二道防线。
 */
export function bucketDir (dataDir: string, bucket: string): string {
  if (!isBucket(bucket)) throw new Error(`未知的素材桶：${bucket}`)
  return join(libraryRoot(dataDir), bucket)
}

/**
 * 某条素材在磁盘上的绝对路径。
 *
 * 【经 bucketDir 走白名单】——bucket 是库里存的字符串，不是常量；
 * 索引可能是旧版本写的、也可能被手工改过，不该被当成可信输入。
 */
export function libraryItemPath (
  dataDir: string, item: { bucket: string; filename: string },
): string {
  return join(bucketDir(dataDir, item.bucket), item.filename)
}
