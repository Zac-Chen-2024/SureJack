# 工作台重排 + 字幕时间列表 + 实时预览 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作台从「文案 + 属性面板」改成用户要的四栏流水线布局：说什么 → 用什么 → 出来什么。并补上字幕时间列表与 JASSUB 实时预览。

**Architecture:** 字幕行和 ASS 文本**都由已存的词时间轴现推**，不新增数据库字段——`wordTimingsJson` 已经在项目表里，`segmentLines()` 和 `buildAss()` 已经存在，只是此前只在导出时用。新增两个只读接口把它们暴露给前端，前端用 JASSUB（libass 的 wasm 版）渲染同一份 ASS，与 ffmpeg 烧录的结果天然一致。

**Tech Stack:** React 19 / Vite 8 / Tailwind 4 / Zustand / JASSUB (libass-wasm) / Fastify / vitest

## Global Constraints

- 测试框架 **vitest**；`npm test` 会先跑 `tsc --noEmit && tsc -b web` 再跑 vitest。
- **每个 `expect(...)` 必须接 matcher**，否则假绿。
- tsconfig 开了 **noUncheckedIndexedAccess**，`arr[0].field` 过不了类型检查；整体比对或 `.map()`，**不要用 `!` 绕过**。
- **不新增数据库字段**。字幕是派生数据，设计文档第 4 节定了「不入库」。
- **不要用 emoji**。图标一律用 `components/ui/Icon.tsx` 里的 SVG（1.5 描边、圆头），不够就按同样风格新增。
- 配色只用既有设计令牌（`ink-*` 灰阶 + 唯一强调色 `accent` 琥珀金）。**不要引入新颜色**。
- 焦点样式沿用 `index.css` 既有规则；大面积书写区用 `.surface-focus-soft`。**不要在全局 `:focus-visible` 里加 `border-color`**——那会压掉各组件自己的边框，整块看起来像报错状态（这个坑踩过一次）。

---

## 布局目标

用户原话的四栏，从左到右正好是制作流程：**说什么 → 用什么 → 出来什么**。

```
┌────────┬─────────────────┬──────────────┬─────────────────┐
│        │  文案编辑        │  背景视频     │                 │
│ 项目   │                 │  ┌──┐┌──┐    │    ┌─────────┐  │
│ 列表   │  （可写可改）    │  └──┘└──┘    │    │         │  │
│        │                 │              │    │  9:16   │  │
│ ·你好  ├─────────────────┤  背景音乐     │    │  预览    │  │
│ ·包子  │  时间 · 字幕     │  ┌────────┐  │    │         │  │
│        │  0:00 他决定去   │  └────────┘  │    │ 字幕实时 │  │
│        │  0:03 买包子。   │              │    │ 跟着走   │  │
│        │  0:07 老板说…    │  音量平衡     │    └─────────┘  │
│        │  ← 点一行跳转    │  ──●───      │    ▶ ────────   │
│        │                 │              │    [导出]       │
│  240   │      420        │     260      │      400        │
└────────┴─────────────────┴──────────────┴─────────────────┘
```

**窄屏退让**（用户已拍板）：宽度不足时**项目列表自动收起**，四栏区域完整保留。项目列表本来就支持折叠，切项目的频率远低于编辑。

**本计划范围外**：中间栏的「三段式拼接预览条」要等背景公式的桶模型落地（见 `2026-07-18-material-library-and-bg-formula.md`）。本计划中间栏先保持现有的单视频选择，结构留好位置。

---

## 文件结构

- `src/subtitles/routes.ts` — **新建**。两个只读派生接口。
- `src/server.ts` — **修改**。注册上面的路由。
- `web/src/store/subtitles.ts` — **新建**。字幕行 + ASS 文本的状态。
- `web/src/components/SubtitleList.tsx` — **新建**。时间-字幕列表。
- `web/src/components/Preview.tsx` — **新建**。JASSUB 预览 + 播放控制。
- `web/src/pages/Workspace.tsx` — **重写**。四栏布局。
- `web/src/components/ui/Icon.tsx` — **修改**。补播放/暂停等图标。
- `web/vite.config.ts` — **修改**。JASSUB 的 worker/wasm 资源处理。
- `tests/subtitles/routes.test.ts` — 新建。

---

### Task 1: 字幕派生接口

**Files:**
- Create: `src/subtitles/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/subtitles/routes.test.ts`

**Interfaces:**
- Consumes: `segmentLines`、`buildAss`（`../subtitles/index.js`）、`withUserDb`、`requireAuth`
- Produces:
  - `GET /api/projects/:id/subtitles` → `{ lines: SubtitleLine[] }`
  - `GET /api/projects/:id/subtitles.ass` → `text/plain`，ASS 全文

**设计要点：**
- **纯派生，不落库**。每次请求现从 `project.wordTimingsJson` 推。词时间轴几千条、`segmentLines` 是 O(n) 纯函数，开销可忽略。
- 还没生成配音时（`wordTimingsJson` 为空）返回 `{ lines: [] }` 和空 ASS，**不是 404**——前端要区分「没有字幕」和「项目不存在」。
- ASS 的构造参数（画幅、标题、免责声明）必须和 `src/queue/routes.ts` 导出时用的**完全一致**，否则预览和成片不符，整个 WYSIWYG 架构就白搭了。**把那段构造逻辑抽成共用函数，两处都调它**，不要复制粘贴。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
// …建测试服务器、建项目、写入 wordTimingsJson…

describe('字幕派生接口', () => {
  it('没生成配音时返回空列表而不是 404', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ lines: [] })
  })

  it('有词时间轴时推导出字幕行', async () => {
    // 写入 3 个词的时间轴
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles` })
    expect(r.json().lines.length).toBeGreaterThan(0)
    expect(r.json().lines[0]).toHaveProperty('startMs')
  })

  it('ASS 接口返回可解析的字幕文本', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/${id}/subtitles.ass` })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('[Script Info]')
    expect(r.body).toContain('[Events]')
  })

  /*
   * 【这条是 WYSIWYG 的地基】预览用的 ASS 必须和导出烧录的完全一致。
   * 两处若各自构造，样式迟早会漂移，而症状是「预览好好的，导出不对」——
   * 极难排查。所以构造逻辑必须是同一个函数。
   */
  it('预览的 ASS 与导出用的 ASS 逐字节相同', async () => {
    const preview = (await app.inject({ url: `/api/projects/${id}/subtitles.ass` })).body
    const exported = buildAssForProject(project)   // 导出路径调的同一个函数
    expect(preview).toBe(exported)
  })

  it('别人的项目拿不到字幕', async () => {
    // 用另一个用户的会话请求同一个项目 id，应 404
  })
})
```

- [ ] **Step 2–5:** 跑失败 → 抽共用函数并实现 → 跑通过 → 提交

```bash
git commit -m "feat(subtitles): 字幕行与 ASS 的只读派生接口"
```

---

### Task 2: 字幕时间列表

**Files:**
- Create: `web/src/store/subtitles.ts`
- Create: `web/src/components/SubtitleList.tsx`

**设计要点：**
- 每行左侧是时间戳，右侧是字幕文字。时间戳用 **`font-variant-numeric: tabular-nums`**，否则数字宽度不一，一列时间戳会参差不齐。
- 时间戳用 `ink-400`，文字用 `ink-100`——时间是索引，文字才是内容。
- **当前播放行高亮**：背景 `ink-700`，左侧一条 2px 的 `accent` 竖条。不要整行染成琥珀色，太抢。
- 点击某行 → 预览跳到该时间点（通过 store 通信，Task 3 接上）。
- **空状态要说人话**：还没生成配音时，这里不是空白，而是一句说明——「字幕由配音时间轴自动生成，先在右侧生成配音」。这是本产品的核心设定，用户第一次看到时需要被告知。
- 列表可能几百行，用 `overflow-y-auto`；当前行变化时 `scrollIntoView({ block: 'nearest' })`——用 `nearest` 而不是 `center`，否则每秒都在滚，看着晕。

---

### Task 3: JASSUB 实时预览

**Files:**
- Create: `web/src/components/Preview.tsx`
- Modify: `web/vite.config.ts`
- Modify: `web/src/components/ui/Icon.tsx`

**这个任务同时了结 Spike 3**（JASSUB 与 ffmpeg 烧录的一致性验证，从阶段 0 挂到现在）。

**技术要点，都是踩过的坑：**
- **wasm 的 MIME 必须是 `application/wasm`**。阶段 0 的 JASSUB spike 失败，根因之一就是服务端没配这个 MIME（浏览器报 `Incorrect response MIME type`）。nginx 的全局 `mime.types` 已经加过，但**开发用的 Vite dev server 和 Fastify 静态托管也要确认**。
- **字体必须是 `Noto Sans CJK SC`**，不是 `Noto Sans SC`（后者不存在，`fc-match` 会静默回退到无中文字形的 DejaVu Sans，渲染出一片豆腐块且不报错）。JASSUB 要显式传入字体文件。
- 播放器用原生 `<video>` 播背景视频 + `<audio>` 播配音？**不要**——两个媒体元素的时钟会漂。用单个 `<video>`，配音作为它的音轨；配音还没合成进视频时，预览阶段用 `<audio>` 作为**唯一**时间源，画面用背景视频静音循环跟随 `audio.currentTime`。
- JASSUB 实例在项目切换/组件卸载时必须 `destroy()`，否则 worker 泄漏。

**验收（Spike 3 的原始目标）：** 同一时间点，预览截图与 `ffmpeg` 烧录出的帧，字幕位置和高亮进度应一致。测试方式：导出成片后用 ffmpeg 抽某一帧，与预览在同一 `currentTime` 的截图并排比对。**这一步需要人眼确认，不要让子代理自述通过。**

---

### Task 4: 四栏布局

**Files:**
- Modify: `web/src/pages/Workspace.tsx`
- Modify: `web/src/components/AssetPanel.tsx`（挪进中间栏，去掉自己的外层卡片）

**设计要点：**
- 用 CSS Grid 定列宽，不要嵌套 flex——四栏用 `grid-template-columns` 一句话说清，可读性远好于层层 flex。
- 分栏靠**极细描边**（`border-line`）+ 背景色差，不要用粗分隔线。
- **窄屏**：`@media (max-width: 1400px)` 时项目列表自动 `collapsed`。用 `matchMedia` 监听，但**用户手动展开后不要再自动收**——自动行为覆盖用户的显式操作是很烦人的体验。
- 左列上下分割用 `grid-rows`，文案区和字幕列表各占一半，中间一条 `border-line`。

---

## 完成标准

- [ ] 四栏布局在 1440 宽下不挤，1280 下项目列表自动收起
- [ ] 生成配音后，字幕时间列表出现内容；点某行预览跳转
- [ ] 预览里字幕跟着播放实时走，卡拉OK 高亮可见
- [ ] **预览与导出成片的同一帧，字幕位置一致**（Spike 3 验收，人眼确认）
- [ ] 没生成配音时，字幕列表显示说明而非空白
- [ ] 无 emoji；无新颜色；`npm test` 全绿（含前端类型检查）
