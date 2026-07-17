import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = resolve(join(__dirname, '..', '..', 'data'))

export function isWhitelisted (name: string, list: string[]): boolean {
  return name.length > 0 && list.includes(name)
}

/**
 * 返回某用户的数据目录绝对路径。
 *
 * ⚠️ 防路径穿越的核心：【先校验白名单，再拼路径】。
 * 因为姓名必须精确等于白名单里的某一项（includes 全等比较），
 * 任何 "../"、"张三/../李四" 之类的构造都不可能等于白名单项，
 * 于是在 isWhitelisted 这一步就被挡死，根本走不到拼路径。
 * 这是设计文档第 4 节说的"防路径穿越的第一道闸"。
 *
 * 额外再加一道保险：拼出的路径必须仍在 DATA_ROOT 之内。
 */
export function userDbDir (name: string, list: string[]): string {
  if (!isWhitelisted(name, list)) {
    throw new Error(`拒绝：姓名不在白名单内`)
  }
  const dir = resolve(join(DATA_ROOT, name))
  // 双保险：即便白名单里混进了危险字符，也不允许逃出 data 根目录
  if (!dir.startsWith(DATA_ROOT + '/') && dir !== DATA_ROOT) {
    throw new Error('拒绝：数据路径逃逸')
  }
  return dir
}
