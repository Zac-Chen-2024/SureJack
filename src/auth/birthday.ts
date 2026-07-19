/**
 * 「忘了密码」的验证答案：生日的月和日。
 *
 * ⚠️【这是一个很弱的凭据，别当它是安全机制】
 * 月+日只有 366 种可能，而实际有效答案只有名单里那几个人的生日——
 * 一个脚本几秒就能把 366 种全试完。真正拦住枚举的【只有限流】
 * （见 routes.ts 里这条路由的 rateLimit 配置）。改动这块时，
 * 谁要是顺手把限流放宽了，这个功能立刻等于把两个账号的密码公开。
 *
 * 所以还有两条规矩：
 *   - 【答错绝不能说"这个生日不对"】否则它就成了一个"某天是不是
 *     某人生日"的查询接口，能一天天问出真实生日。
 *   - 【真答案不入库】和白名单、欢迎语一样放 config/ 并 gitignore：
 *     真实生日是个人信息。
 */

export interface Birthday { month: number; day: number }

/**
 * 哪个人的生日是这一天。没人对得上就返回 null。
 *
 * 【只在名单内匹配】：配置文件万一混进一个不在白名单的名字，
 * 也不该能靠它重置出一个账号来。
 */
export function whoseBirthday (
  table: Record<string, Birthday>,
  whitelist: string[],
  month: number,
  day: number,
): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  for (const [name, b] of Object.entries(table)) {
    if (!whitelist.includes(name)) continue
    if (b.month === month && b.day === day) return name
  }
  return null
}
