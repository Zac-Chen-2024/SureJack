# 素材栏改为素材库驱动 + 背景公式接入导出 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 素材栏不再有"上传"——背景视频是从素材库按三段式公式自动拼的，用户看到的是拼接预览；背景音乐从素材库 9 首里选。配音挪到字幕栏（字幕本来就是配音生成的）。

**Architecture:** `data/library/` 里 210 个文件已就位。新增 library 只读接口把它们暴露给前端；导出时用已写好的 `planBackground()` 算出三段排布，生成背景轨再进烧录管线。项目只存**引用**，不复制文件。

**Tech Stack:** TypeScript / Fastify / better-sqlite3 / ffmpeg / React 19 / Zustand / vitest

## Global Constraints

- **素材栏没有上传。** 素材是本地 `data/library/` 那 210 个文件，用户只能选、不能传。任何"上传"按钮都是错的。
- 素材库**全局公用**（`data/library/`，不经过 `userDbDir()`）。桶白名单 `isBucket` 是**唯一**一道目录穿越防线。
- **绝不按项目复制素材**。地铁跑酷单桶 4.7GB，项目只存素材 id。
- 三段比例默认 `27% / 27% / 46%`，`planBackground()` 已实现并测透，**直接用，不要重写**。
- 测试框架 **vitest**；`npm test` 会先跑 `tsc --noEmit && tsc -b web`。
- **每个 `expect(...)` 必须接 matcher**，否则假绿。
- tsconfig 开了 **noUncheckedIndexedAccess**，`arr[0].field` 过不了；整体比对或 `.map()`，**不要用 `!` 绕过**。
- **不要用 emoji**；图标用 `web/src/components/ui/Icon.tsx` 的 SVG（1.5 描边圆头）。
- **不引入新颜色**，只用 `ink-950..50` + `accent`（琥珀金 #f0b429）。

---

## 接口契约（前后端并行的依据，先定死）

后端按这个实现，前端按这个对接。**任何一方觉得契约不对，先提出来，不要单方面改。**

```typescript
// 素材库条目
interface LibraryItem {
  id: string            // 稳定 id，重扫不变
  bucket: string        // '1-开头' | '2-常规' | '3-地铁跑酷' | '背景音乐'
  filename: string      // 原始文件名，当作不透明字符串（素材包里有 6月1日(8.mp4 这种残缺名）
  durationMs: number
  sizeBytes: number
}

// 三段排布中的一段
interface BgSegment {
  itemId: string
  filename: string      // 前端要显示，避免再查一次
  bucket: string
  startMs: number       // 从源文件的哪一刻开始截
  takeMs: number        // 截多长
}
```

- `GET /api/library/:bucket` → `{ items: LibraryItem[] }`
- `POST /api/library/scan` → `{ scanned: Record<string, number> }`（四个桶各入库多少条）
- `GET /api/projects/:id/background-plan` → `{ segments: BgSegment[], totalMs: number }`
  - 配音未就绪时返回 `{ segments: [], totalMs: 0 }`，**不是 404**
- `PATCH /api/projects/:id` 新增可选字段 `bgmLibraryId: string | null`

---

### Task 1: 素材库只读接口 + 首次扫描

**Files:** `src/library/routes.ts`（新）、`src/server.ts`、`tests/library/routes.test.ts`（新）

已有可用的：`src/library/paths.ts`（`BUCKETS` / `isBucket` / `bucketDir`）、`src/library/scan.ts`（`scanBucket` / `listBucket`）、`src/library/library-db.ts`（`openLibraryDb`）。**都不要重写。**

要点：
- 桶名来自路由参数，**必须先过 `isBucket`**——它是唯一防线
- 需要登录才能看（`requireAuth`），但素材库是公用的，不按用户过滤
- 扫描是幂等的，重复调不产生重复行

测试至少覆盖：四个桶都能列出、未知桶名 400、穿越路径被拒、未登录 401、重复扫描幂等。

---

### Task 2: 背景排布接口

**Files:** `src/library/background.ts`（新）、`src/projects/routes.ts`、测试

把 `planBackground()`（`src/compose/plan.ts`，已测透）接上真实素材库：读三个视频桶的 `listBucket()`，用项目的 `ttsDurationMs` 当总长，算出排布，补上 `filename`/`bucket` 供前端显示。

**排布必须是确定性的**——同一个项目每次算出来一样，否则用户每刷新一次预览条就变，而导出时又是另一个结果。若 `planBackground` 内部有随机性，用项目 id 做种子。

---

### Task 3: 背景公式接入导出

**Files:** `src/compose/build.ts`（新）、`src/queue/routes.ts`、`src/render/*`、测试

按排布生成一条与配音等长的背景轨，再进现有烧录管线。

技术要点：
- **分辨率必须先统一**。concat demuxer 要求所有输入参数一致；素材来源杂乱，先 `scale + crop + fps + setsar` 归一化
- **地铁跑酷源文件达 1GB，`-ss` 必须放在 `-i` 之前**（输入端快速定位，跳过解码）。放后面会从头解码到截取点，1GB 文件上差几十秒
- **一律 `-an` 去掉音频**——背景视频静音是设计约束
- 中间片段落在临时目录，结束后清理
- 进度要计入导出进度条：13 分钟视频的背景轨生成不是瞬时的，不能让进度卡在 0%
- **保留旧路径**：项目若已有上传的背景视频（`bg_mode='single'`），行为不变。公式模式是新增，不是替换

---

### Task 4: 布局收成三栏 + 素材区库驱动

**Files:** `web/src/pages/Workspace.tsx`、`web/src/components/AssetPanel.tsx`（重写）、`web/src/store/library.ts`（新）

**背景是全自动的，不需要人操作，所以它不配占一整栏。** 原来的四栏收成三栏：

```
┌────────┬──────────────────┬──────────────────┐
│ 项目   │  文案编辑         │   9:16 预览       │
│ 列表   │  ──────────────  │                  │
│(可折叠)│  配音 + 字幕      │  ──────────────  │
│        │  0:00 老陈…      │  背景（自动）     │
│        │  0:03 每天…      │  背景音乐 ○●○     │
│        │                  │  音量 ──●──      │
│        │                  │  [导出]          │
│  240   │   minmax(0,1fr)  │  minmax(380,460) │
└────────┴──────────────────┴──────────────────┘
```

**右栏是「出来什么 + 用什么料」合并**：预览在上（占大头），素材设置在下（紧凑）。

- **没有任何上传按钮。**
- **背景视频区极简**：一条按 takeMs 等比的三段条 + 一行文字说明（`3:31 开头 · 3:31 常规 · 6:01 地铁跑酷`）。**不做片段列表、不做重选**——全自动就该看起来全自动。分段条三段用同一强调色的不同明度（`accent` 全亮 / 60% / 30%），不引入新颜色
- **BGM 单选，9 选 1**。文件名首个空格前是曲名，其余是标签（`一笑倾城 现言 甜文.wav` → 曲名「一笑倾城」，标签「现言 甜文」）。标签用小号 `ink-400` 排在曲名右侧
- 音量平衡滑块要真能拖（`bgm_volume` 后端一直在用，前端从来没接过）
- 配音未生成时分段条显示「生成配音后按时长自动排布」——背景长度由配音决定

### Task 5: 配音挪进字幕栏

**Files:** `web/src/components/SubtitleList.tsx`、`web/src/components/VoicePanel.tsx`、`web/src/pages/Workspace.tsx`

**字幕是配音生成的，它俩是一件事。** 现在配音在中间栏、字幕在左下栏，用户要在两栏之间来回看才知道为什么字幕是空的。

- 配音的生成按钮和状态移到字幕列表**上方**，作为那一栏的头部
- 字幕空状态改成「先生成配音，字幕会自动出现」并且**就在生成按钮旁边**——因果关系要在同一个视野里
- 中间栏不再有配音相关的任何东西

---

### Task 6: BGM 循环铺满（现有 bug）

**Files:** `src/render/filters.ts`、`src/render/ffmpeg.ts`、测试

**这是用户「一个视频只用一个 BGM、循环播放」这句话暴露的现有缺陷。**

`buildAudioFilter` 用 `amix=duration=first`：BGM 比配音长会截断（对），但**比配音短时不会循环**——放完就静音，剩下全程没有背景音乐。

实测素材库里 9 首 BGM 时长 7.6–11.6 分钟。用户昨天那条 13 分钟的片子：
- 用最长的「若梦」（11.6 分钟）→ 最后 1.4 分钟静音
- 用最短的「一笑倾城」（7.6 分钟）→ **最后 5.5 分钟静音**

修法：BGM 输入加 `-stream_loop -1`（输入端循环，不是 `aloop` 滤镜——后者按帧工作、吃内存），`amix` 保持 `duration=first` 让它在配音结束时收住。

测试必须覆盖：**BGM 短于配音时，成片全程都有背景音乐**。这条要真跑 ffmpeg 验证音频轨的能量分布，不能只看时长——时长本来就是对的，静音的那段也算时长。

---

## 完成标准

- [ ] 素材栏没有任何上传按钮
- [ ] 背景视频显示三段式拼接预览，与导出实际用的排布**一致**
- [ ] BGM 从素材库 9 首里选，标签正确解析
- [ ] 音量平衡滑块真能拖并影响成片
- [ ] 配音和字幕在同一栏
- [ ] 主区是两栏（文案+字幕 / 预览+素材），背景不占独立栏
- [ ] BGM 短于配音时循环铺满，不会中途静音
- [ ] 导出的成片背景真的是「开头 → 常规 → 地铁跑酷」
- [ ] `npm test` 全绿
