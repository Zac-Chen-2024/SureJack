import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/db/user-db-crud.test.ts 和 tests/projects/routes.test.ts 都用真实姓名
    // '测试甲'/'测试乙' 打开【同一份物理落盘的 SQLite 文件】（openUserDb 的物理
    // 隔离设计就是按姓名唯一定位真实文件，不认 authDbPath: ':memory:'）。
    // Vitest 默认按文件并行跑在不同 worker 里，两个文件的用例会并发读写同一个
    // .db 文件，实测会互相踩掉对方刚建的项目行（一边 DELETE FROM projects 或
    // 拿着 id 更新时，行已经被另一个 worker 删了），偶发 flaky。关掉跨文件并行，
    // 让所有测试文件顺序跑，从根上消掉这类共享真实文件的竞态。
    fileParallelism: false,
  },
})
