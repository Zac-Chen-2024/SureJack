# 公用素材库 + 三段式背景公式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 背景视频不再是「选一个文件」，而是按固定公式自动拼出一条与配音等长的轨道：开头 → 常规 → 地铁跑酷，素材取自账号级的公用素材库。

**Architecture:** 新增**全局公用素材库**（三个视频桶 + 一个音乐桶），全站只存一份、所有用户所有项目共享引用。导出时按配音总长把时间轴按比例切成三段，每段用各自桶里的素材铺满，生成一条背景轨，再进入现有的字幕烧录管线。

**Tech Stack:** TypeScript / Node / better-sqlite3 / ffmpeg / vitest

## ⚠️ 这份计划在隔离模型上开了一个有意的口子

本项目此前的铁律是：**数据路径由会话身份经白名单派生，代码里没有任何 `WHERE owner = ?`**。一人一个 SQLite 文件，物理隔离。

素材库**不遵守这条铁律**——它是全局的，不属于任何用户：

```
data/
├── auth.db
├── library/          ← 全局公用，不经过 userDbDir()
│   ├── library.db      素材索引（全站一份）
│   └── {四个桶}/
├── 陈梓昂/app.db     ← 项目/文案/成片，仍然物理隔离
└── 黄诗婕/app.db     ← 项目/文案/成片，仍然物理隔离
```

**为什么可以**：素材库里是开头片、解压视频、地铁跑酷录屏——两个用户本来就用同一批，不含任何私有内容。按人各存一份就是 8.4GB × 2 的纯浪费。

**代价，实现者必须清楚**：素材路径不再经过 `userDbDir()`，所以 **`BUCKETS` 白名单从此是防目录穿越的唯一一道闸**（此前它是第二道，`userDbDir` 是第一道）。Task 1 的穿越测试因此比原先更关键——它守的是唯一的门。

**隔离的实质没有丢**：项目、文案、时间轴、成片仍然一人一库，一个用户永远看不到另一个用户的项目。共用的只是那批谁都能看的素材。

## Global Constraints

- **素材库是全局公用的**，路径 `data/library/{1-开头,2-常规,3-地铁跑酷,背景音乐}/`，**不经过 `userDbDir()`**。
- 素材索引 `data/library/library.db` **全站一份**，与各用户的 `app.db` 分开。不要把 `library_items` 表塞进用户库——两份索引扫同一个目录必然漂移。
- **绝不按项目、也绝不按用户复制素材文件**。地铁跑酷单桶就约 5GB。项目只存**引用**（素材 id）。
- 三段时长**按比例分配**：默认 `开头 27% / 常规 27% / 地铁跑酷 46%`（与用户举例的 11 分钟 → 3/3/5 分钟一致）。
- 素材不够铺满某段时**按顺序截断顺延**，不循环重复同一批素材。地铁跑酷桶是唯一允许在单文件内截取长片段的桶。
- 一二号桶：**多个短片拼接**。三号桶：**从长录屏里截一段**（源文件达 1GB，必须用快速定位）。
- 背景视频**一律静音**（设计文档既有约束），音频只来自配音 + BGM。
- 现有 224 测试必须保持全绿。
- **测试框架是 vitest**（`describe`/`it`/`expect`），不是 `node:test`。仓库的 `npm test` 就是 `vitest run`，且 `vitest.config.ts` 的 include 是 `tests/**/*.test.ts`——用 `node:test` 写的文件会被扫进来并报 「No test suite found」，让整个套件变红。
- **每个 `expect(...)` 后面必须接 matcher**（`.toBe` / `.toEqual` / `.toThrow` …）。光写 `expect(布尔表达式)` 什么都不断言，测试会假绿。
- 中文注释，与现有代码风格一致。

---

## 素材库的现实数据（实现者必读）

用户的 `Material/Video.zip`（8.4GB，无压缩）解压后：

| 桶 | 数量 | 单文件大小 | 用法 |
|---|---|---|---|
| `1-开头` | 约 80 | 5–35MB | 短片，**拼接**铺满 |
| `2-常规解压` | 约 115 | 5–35MB | 短片，**拼接**铺满 |
| `3-地铁跑酷` | 9 | **248MB–1.08GB** | 长录屏，**截取**一段 |
| `背景音乐` | 10 | 16–99MB | 单选一首 |

两个真实的坑：

1. **文件名含单引号**：`剪素材n'n.mp4` 确实存在。ffmpeg concat 清单里必须把 `'` 转义成 `'\''`，否则清单被解析错。
2. **文件名批量损坏**：`6月1日(8.mp4`、`剪素材(1.mp4` 这类缺右括号的名字大量存在。不要试图从文件名解析任何语义，**只当作不透明字符串**。

---

## 文件结构

- `src/library/paths.ts` — **新建**。全局素材库目录 + 桶名白名单（唯一的穿越防线）。
- `src/library/library-db.ts` — **新建**。打开全站唯一的 `data/library/library.db`。
- `src/library/scan.ts` — **新建**。扫描桶目录、ffprobe 时长、写入索引表。
- `src/library/routes.ts` — **新建**。列出素材、上传到指定桶。
- `src/compose/plan.ts` — **新建**。**纯函数**：给定配音总长 + 各桶素材时长，算出「用哪些片、各取几秒」。核心逻辑，无 IO。
- `src/compose/build.ts` — **新建**。按 plan 用 ffmpeg 生成背景轨。
- `src/db/user-db.ts` — **修改**。新增 `library_items` 表与项目的桶配置字段。
- `src/render/ffmpeg.ts` — **修改**。接受预生成的背景轨。
- `tests/compose/plan.test.ts`、`tests/library/paths.test.ts` 等 — 新建。

---

### Task 1: 素材库路径与桶白名单

**Files:**
- Create: `src/library/paths.ts`
- Test: `tests/library/paths.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const BUCKETS: readonly string[]        // ['1-开头','2-常规','3-地铁跑酷','背景音乐']
  export type Bucket = typeof BUCKETS[number]
  export function isBucket (s: string): s is Bucket
  export function libraryRoot (dataDir: string): string
  export function bucketDir (dataDir: string, bucket: string): string
  ```

**注意签名里没有用户名，也没有白名单**——素材库是全局的，不按身份派生路径。

**安全要点（这份计划里最要紧的一条）：** `bucketDir` 必须**先查桶白名单再拼路径**。因为不再有 `userDbDir()` 兜底，**`isBucket` 是防目录穿越的唯一一道闸**。桶名来自 HTTP 路由参数（`/api/library/:bucket`），是纯粹的外部输入。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
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
      '1-开头\\0/etc',                // 空字节截断
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
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/library/paths.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/library/paths.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/library/paths.ts tests/library/paths.test.ts
git commit -m "feat(library): 素材库路径派生与桶白名单"
```

---

### Task 2: 素材索引表与扫描

**Files:**
- Create: `src/library/library-db.ts`
- Create: `src/library/scan.ts`
- Test: `tests/library/scan.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface LibraryDb { /* better-sqlite3 Database 的封装，与 UserDb 同风格 */ }
  export function openLibraryDb (dataDir: string): LibraryDb
  export interface LibraryItem {
    id: string; bucket: string; filename: string; durationMs: number; sizeBytes: number
  }
  export function scanBucket (
    db: LibraryDb, dataDir: string, bucket: string
  ): Promise<{ added: number; total: number }>
  export function listBucket (db: LibraryDb, bucket: string): LibraryItem[]
  ```

**数据模型：** 全站唯一的 `data/library/library.db`，内含 `library_items` 表。

**不要把这张表放进用户的 `app.db`**——那样两个用户各有一份索引、扫的却是同一个目录，一个人上传后另一个人的索引就是陈旧的，而且两份索引会各自生成不同的 id 指向同一个文件。**一个目录只能有一份索引。**

这是个全新的库文件，建表可直接用 `CREATE TABLE IF NOT EXISTS`。但**将来给它加列时**必须走 `PRAGMA table_info` + `ALTER TABLE`——`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，本项目已经踩过一次。

```sql
CREATE TABLE IF NOT EXISTS library_items (
  id          TEXT PRIMARY KEY,
  bucket      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (bucket, filename)
);
```

**扫描要点：**
- 幂等：重复扫描不产生重复行（靠 `UNIQUE (bucket, filename)` + `INSERT OR IGNORE`）。
- 只处理已知扩展名（复用 `isAllowedUpload`），跳过其余文件。
- 逐个 ffprobe。约 200 个文件、其中 9 个是 GB 级——**ffprobe 只读元数据不解码，即使 1GB 文件也在毫秒级**，不必并发。
- 单个文件探测失败（损坏）**不能中断整轮扫描**，记录并跳过。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { scanBucket, listBucket } from '../../src/library/scan.js'
// 测试用真实的小视频：用 ffmpeg 现生成，避免依赖用户的 8GB 素材

it('扫描把桶里的视频写进索引', async () => {
  // …建临时用户目录、放 2 个 1 秒的测试视频…
  const r = await scanBucket(db, '测试用户', WL, '1-开头')
  expect(r.added).toBe(2)
  const items = listBucket(db, '1-开头')
  expect(items.length).toBe(2)
  expect(items[0].durationMs > 500, '应探测到时长').toBe(true)
})

it('重复扫描幂等，不产生重复行', async () => {
  await scanBucket(db, '测试用户', WL, '1-开头')
  const r2 = await scanBucket(db, '测试用户', WL, '1-开头')
  expect(r2.added).toBe(0, '第二次不应新增')
  expect(listBucket(db).toBe('1-开头').length, 2)
})

it('损坏文件被跳过，不中断整轮扫描', async () => {
  await writeFile(join(dir, 'broken.mp4'), 'not a video')
  const r = await scanBucket(db, '测试用户', WL, '1-开头')
  expect(listBucket(db).toBe('1-开头').length, 2, '坏文件不应入库')
})

it('文件名含单引号也能正常入库', async () => {
  // 用户素材里真实存在：剪素材n'n.mp4
  await makeVideo(join(dir, "剪素材n'n.mp4"), 1)
  await scanBucket(db, '测试用户', WL, '1-开头')
  expect(listBucket(db, '1-开头').some((i) => i.filename.includes("'"))).toBe(true)
})
```

- [ ] **Step 2–5:** 跑失败 → 实现 → 跑通过 → 提交

```bash
git commit -m "feat(library): 素材索引表与幂等扫描"
```

---

### Task 3: 三段式排布算法（本计划的核心）

**Files:**
- Create: `src/compose/plan.ts`
- Test: `tests/compose/plan.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface Segment { itemId: string; startMs: number; takeMs: number }
  export interface ComposePlan { segments: Segment[]; totalMs: number }
  export const DEFAULT_RATIO: readonly [number, number, number]  // [0.27, 0.27, 0.46]
  export function planBackground (
    totalMs: number,
    buckets: { opening: LibraryItem[]; regular: LibraryItem[]; parkour: LibraryItem[] },
    ratio?: readonly [number, number, number]
  ): ComposePlan
  ```

**这是纯函数，没有 IO，是整个功能里最该被测透的一环。**

**规则：**
1. 三段的目标时长 = `totalMs × ratio[i]`，最后一段吃掉除不尽的余数（保证总和精确等于 `totalMs`）。
2. **开头/常规段**：按桶内顺序依次取整片，直到铺满；最后一片按需截断。
3. **地铁跑酷段**：桶里是 GB 级长录屏——**取单个文件的一段**即可，不拼接。若单文件不够长才续下一个。
4. **素材不够铺满某段**：把缺口顺延给下一段，**不循环重复**。
5. **最后一段仍不够**：只能循环——但这是最后手段，且要能被测试观察到。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { planBackground, DEFAULT_RATIO } from '../../src/compose/plan.js'

const item = (id: string, durationMs: number) =>
  ({ id, bucket: 'x', filename: `${id}.mp4`, durationMs, sizeBytes: 0 })

const buckets = {
  opening: [item('o1', 30000), item('o2', 30000), item('o3', 30000)],   // 90 秒
  regular: [item('r1', 30000), item('r2', 30000), item('r3', 30000)],   // 90 秒
  parkour: [item('p1', 1800000)],                                       // 30 分钟
}

const sumMs = (segs: Segment[]) => segs.reduce((a, s) => a + s.takeMs, 0)

describe('planBackground', () => {
  /*
   * 【最重要的一条】总长差一毫秒，成片结尾就会黑一帧或截掉半个字。
   * 123457 这个不能被 3 整除的数是故意的——按比例分配必然除不尽，
   * 余数必须被某一段吃掉，不能四舍五入丢掉。
   */
  it('总时长精确等于配音时长——一毫秒都不能差', () => {
    for (const total of [60000, 240000, 660000, 123457, 1]) {
      expect(sumMs(planBackground(total, buckets).segments)).toBe(total)
    }
  })

  it('11 分钟配音里地铁跑酷占最大一段', () => {
    const p = planBackground(660000, buckets)
    const parkourMs = sumMs(p.segments.filter((s) => s.itemId === 'p1'))
    // 开头桶只有 90 秒，铺不满 178 秒 → 缺口顺延（规则 4）
    expect(parkourMs).toBeGreaterThan(250000)
  })

  it('素材够时，开头段接近目标比例', () => {
    const rich = {
      opening: Array.from({ length: 20 }, (_, i) => item(`o${i}`, 30000)), // 10 分钟
      regular: Array.from({ length: 20 }, (_, i) => item(`r${i}`, 30000)),
      parkour: [item('p1', 1800000)],
    }
    const opening = sumMs(planBackground(660000, rich).segments
      .filter((s) => s.itemId.startsWith('o')))
    expect(opening).toBeGreaterThan(660000 * 0.27 - 30000)
    expect(opening).toBeLessThan(660000 * 0.27 + 30000)
  })

  it('不循环重复：素材够时同一片不出现两次', () => {
    const rich = {
      opening: Array.from({ length: 20 }, (_, i) => item(`o${i}`, 30000)),
      regular: Array.from({ length: 20 }, (_, i) => item(`r${i}`, 30000)),
      parkour: [item('p1', 1800000)],
    }
    const opens = planBackground(660000, rich).segments
      .filter((s) => s.itemId.startsWith('o')).map((s) => s.itemId)
    expect(new Set(opens).size).toBe(opens.length)
  })

  it('地铁跑酷从长片里截一段，不切成许多碎片', () => {
    const pk = planBackground(660000, buckets).segments.filter((s) => s.itemId === 'p1')
    expect(pk).toHaveLength(1)
    expect(pk[0].takeMs).toBeGreaterThan(250000)
  })

  it('每段的截取区间不超出源文件时长', () => {
    const p = planBackground(660000, buckets)
    const dur = new Map([...buckets.opening, ...buckets.regular, ...buckets.parkour]
      .map((i) => [i.id, i.durationMs]))
    for (const s of p.segments) {
      expect(s.startMs).toBeGreaterThanOrEqual(0)
      expect(s.startMs + s.takeMs).toBeLessThanOrEqual(dur.get(s.itemId)!)
    }
  })

  it('空桶不崩溃，缺口顺延给有素材的桶', () => {
    const p = planBackground(60000,
      { opening: [], regular: [], parkour: [item('p1', 600000)] })
    expect(sumMs(p.segments)).toBe(60000)
  })

  it('全空桶抛出可读的错误', () => {
    expect(() => planBackground(60000, { opening: [], regular: [], parkour: [] }))
      .toThrow(/素材/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/compose/plan.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

实现 `planBackground`。要点已在上方规则列出。**注意最后一段吃余数**，用整数运算避免浮点累积误差。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/compose/plan.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/compose/plan.ts tests/compose/plan.test.ts
git commit -m "feat(compose): 三段式背景排布算法"
```

---

### Task 4: 按排布生成背景轨

**Files:**
- Create: `src/compose/build.ts`
- Test: `tests/compose/build.test.ts`

**Interfaces:**
- Produces: `buildBackground(plan: ComposePlan, resolve: (id: string) => string, outPath: string, width: number, height: number, onProgress?: (pct: number) => void): Promise<void>`

**技术要点：**
- **分辨率必须先统一**。concat demuxer 要求所有输入参数一致；素材来源杂乱，分辨率、帧率、像素格式都不同。每段先 `scale + crop + fps + setsar` 归一化到输出规格。
- **地铁跑酷源文件达 1GB，`-ss` 必须放在 `-i` 之前**（输入端快速定位，跳过解码）。放在 `-i` 之后会从头解码到截取点——1GB 文件上是几十秒的差别。
- **一律去掉音频**（`-an`）——背景视频静音是设计约束。
- 中间片段落在导出任务的临时目录，**结束后清理**。
- `onProgress` 汇报进度：背景轨生成在长视频上耗时可观，导出队列的进度条要覆盖这一阶段，不能卡在 0%。

- [ ] **Step 1: 写失败的测试**

```typescript
it('生成的背景轨时长等于排布总长', async () => {
  // 用 ffmpeg 现生成 3 个测试视频，跑一次真实 build
  await buildBackground(plan, resolve, out, 1080, 1920)
  const d = await probeDurationMs(out)
  expect(Math.abs(d - plan.totalMs) < 500, `期望 ${plan.totalMs}，实际 ${d}`).toBe(true)
})

it('输出分辨率是指定的输出规格', async () => {
  // ffprobe 检查 width/height == 1080/1920
})

it('输出不含音频轨', async () => {
  // ffprobe 应查不到 audio stream
})

it('源素材分辨率不一时也能拼成功', async () => {
  // 生成 1920x1080 与 720x1280 两个源，确认能拼出统一规格
})

it('文件名含单引号的素材能被正常拼接', async () => {
  // 真实存在：剪素材n'n.mp4
})
```

- [ ] **Step 2–5:** 跑失败 → 实现 → 跑通过 → 提交

```bash
git commit -m "feat(compose): 按排布生成统一规格的背景轨"
```

---

### Task 5: 接入导出管线

**Files:**
- Modify: `src/db/user-db.ts`（项目新增背景模式与比例字段）
- Modify: `src/queue/queue.ts`（导出前先生成背景轨）
- Modify: `src/render/ffmpeg.ts`（接受背景轨作为输入）
- Modify: `src/queue/routes.ts`

**数据模型（走 ALTER 增量迁移，线上库已有数据）：**

```typescript
addCol('bg_mode', "bg_mode TEXT NOT NULL DEFAULT 'single'")  // 'single' | 'formula'
addCol('bg_ratio', "bg_ratio TEXT NOT NULL DEFAULT '0.27,0.27,0.46'")
```

`'single'` 保留现有「选一个背景视频」的行为——**已有项目行为不变**，公式模式是新增选项而非替换。

**导出流程变化：**

```
配音就绪 → [新增] 按公式排布 → [新增] 生成背景轨 → 烧录字幕 → 成片
             ↑ 进度 0-40%        ↑ 进度 40-100%
```

进度权重要调整：背景轨生成在 11 分钟视频上不是瞬时的，必须计入进度条。

- [ ] **Step 1–5:** 迁移 → 队列接入 → 测试 → 提交

```bash
git commit -m "feat(export): 导出支持三段式背景公式"
```

---

### Task 6: 素材库接口 + 导入用户的 Video.zip

**Files:**
- Create: `src/library/routes.ts`
- Modify: `src/server.ts`

**接口：**
- `GET /api/library/:bucket` — 列出某桶素材
- `POST /api/library/:bucket` — 上传到某桶
- `POST /api/library/:bucket/scan` — 重扫目录（供手工放文件后同步）

**导入已有素材（一次性操作）：**

素材库是全局的，**这一步完全不碰 `data/陈梓昂/` 或 `data/黄诗婕/`**——不存在污染真实用户数据的风险。

```bash
# 磁盘账：zip 8.4GB（store 无压缩）+ 解压 8.4GB = 16.8GB，当前可用 39GB，够。
# 但解压后应把 zip 移走或删除，否则长期占双份。
df -h /root

# unzip 未安装。用 python 解压——注意 zip 里的中文文件名可能是 GBK 编码，
# Python 会按 cp437 解出乱码，需要显式转码，否则文件名全是问号。
python3 - <<'PY'
import zipfile, os, shutil
src = 'Material/Video.zip'
dst = 'data/library/_import'
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        # zip 未设 UTF-8 标志位时，Python 用 cp437 解码，中文会变乱码
        name = info.filename
        if not info.flag_bits & 0x800:
            name = name.encode('cp437').decode('gbk', errors='replace')
        target = os.path.join(dst, name)
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as s, open(target, 'wb') as d:
                shutil.copyfileobj(s, d)
PY

# 先看解出来的名字对不对，再动。乱码就停下来重解，不要往下走。
ls 'data/library/_import/Video/视频/'

# 目录名对齐到桶名（用户的是「2-常规解压」，桶名是「2-常规」）
mv 'data/library/_import/Video/视频/1-开头'     'data/library/1-开头'
mv 'data/library/_import/Video/视频/2-常规解压' 'data/library/2-常规'
mv 'data/library/_import/Video/视频/3-地铁跑酷' 'data/library/3-地铁跑酷'
mv 'data/library/_import/Video/背景音乐'        'data/library/背景音乐'
rmdir -p 'data/library/_import/Video/视频' 2>/dev/null

# 扫描入库（四个桶各跑一次）
for b in 1-开头 2-常规 3-地铁跑酷 背景音乐; do
  curl -X POST --data-urlencode "b=$b" ".../api/library/$b/scan"
done

# 核对：约 80 / 115 / 9 / 10
```

**⚠️ `data/library/` 必须加进 `.gitignore`。** 8.4GB 素材绝不能进 Git——本项目已经因为 `git add -A` 误提交过 37MB 媒体文件，这次的量级是那次的 200 倍。**在写任何代码之前先加 gitignore。**

- [ ] **Step 1–4:** 接口 → 测试 → 导入 → 提交

---

## 完成标准

- [ ] 11 分钟配音能自动拼出「开头 → 常规 → 地铁跑酷」的背景轨，总长精确等于配音
- [ ] 背景轨分辨率统一、无音轨
- [ ] 素材不按项目复制（磁盘只存一份）
- [ ] 已有项目的 `single` 模式行为不变
- [ ] 文件名含单引号的素材能正常使用
- [ ] 全套测试绿

---

## 后续（另立计划）

**UI 重排 + 实时预览**：中间栏的背景视频区展示三段式拼接预览条；左列上下叠放文案与字幕时间列表；右列 JASSUB 实时预览。这份要等本计划的桶模型落地后再写，否则 UI 无所依附。
