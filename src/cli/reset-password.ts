#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAuthDb } from '../db/auth-db.js'
import { loadWhitelist } from '../server.js'
import { isWhitelisted } from '../auth/whitelist.js'

/**
 * 重置指定姓名的密码。
 *
 * 这是【必需品】（设计文档第 3 节）：
 *   - 忘记密码的唯一解（没有邮箱验证/找回流程）
 *   - "被抢注了就在后端重置"这个兜底方案成立的前提
 *
 * 用法：npm run reset-password -- --name 张三
 * 然后按提示输入新密码（不走命令行参数，避免密码进 shell 历史）。
 */
async function main () {
  const { values } = parseArgs({ options: { name: { type: 'string' } } })
  const name = values.name?.trim()
  if (!name) {
    console.error('用法：npm run reset-password -- --name <姓名>')
    process.exit(1)
  }

  const whitelist = loadWhitelist()
  if (!isWhitelisted(name, whitelist)) {
    console.error(`❌ "${name}" 不在白名单里。白名单：${whitelist.join('、')}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const pw = await rl.question(`为 "${name}" 设置新密码：`)
  rl.close()
  if (pw.length < 4) { console.error('❌ 密码太短'); process.exit(1) }

  const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'auth.db')
  const db = openAuthDb(dbPath)
  await db.setPassword(name, pw, '127.0.0.1(cli-reset)')
  db.close()
  console.log(`✅ 已重置 "${name}" 的密码`)
}

main().catch((e) => { console.error('❌', e instanceof Error ? e.message : e); process.exit(1) })
