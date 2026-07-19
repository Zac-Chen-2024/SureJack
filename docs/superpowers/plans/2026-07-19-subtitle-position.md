# 字幕纵向位置可选 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 用户能调字幕在画面里的高低——不同背景素材主体位置不同，字幕压在脸上还是压在字幕条上，差别很大。

**Architecture:** ASS 的 `MarginV`（配合 `Alignment=2` 底部居中）就是这个参数，单位是像素、从底边往上量。加一列存它，`buildAssForProject` 读它，前端给一个滑块。**预览自动跟随**——JASSUB 和 ffmpeg 读的是同一份 ASS，改了立刻两边都变。

**Tech Stack:** TypeScript / better-sqlite3 / React 19 / Zustand / vitest

## Global Constraints

- 测试框架 **vitest**；`npm test` 先跑 `tsc --noEmit && tsc -b web`
- **每个 `expect(...)` 必须接 matcher**，否则假绿
- tsconfig 开了 **noUncheckedIndexedAccess**，**不要用 `!` 绕过**
- **不要用 emoji**；图标用 `Icon.tsx` 的 SVG
- **不引入新颜色**，只用 `ink-*` + `accent`

---

## ⚠️ 项目名会被烧进画面

`buildAssForProject` 把项目名写成 Title 那一行的正文。**任何塞进项目名的东西都会变成观众看见的标题。** 刚踩过：给项目起名「军师（自备配音）」，那五个字在成片顶部挂了 11 分钟。

本计划不改名字，但改 ASS 构造时要留意这条。

---

### Task 1: 数据模型 + ASS 构造

**Files:** `src/db/user-db.ts`、`src/subtitles/project-ass.ts`、`src/projects/routes.ts`、测试

- `projects` 表加 `subtitle_margin_v INTEGER NOT NULL DEFAULT 120`
  - **必须走 `PRAGMA table_info` + `ALTER TABLE` 增量迁移**——`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，线上库有真实数据，本项目为这个陷阱踩过坑
  - 默认 120 是现在写死在样式行里的值，**保持现有项目的观感不变**
- `buildAssForProject` 用它替换写死的 MarginV
- `PATCH /api/projects/:id` 接受 `subtitleMarginV`

**取值范围要夹紧**：0..（画面高度的一半）。ASS 的 MarginV 是像素值，直接进样式行；给个负数或者超过画面高度，字幕会跑到画外，用户只看到"字幕没了"而不知道为什么。**在路由层 clamp，不要指望前端**。

**免责声明那行也用 MarginV**，别忘了它——两行都在底部，用户把字幕往上推的时候，免责声明该留在原地还是一起动？**留在原地**：它是固定的合规标记，不是内容。测试要钉住这一点。

- 测试：迁移在已有数据的库上生效、默认值不改变现有观感、clamp 生效、免责声明不跟着动。

---

### Task 2: 前端控件

**Files:** `web/src/components/AssetPanel.tsx`（或字幕相关面板，实现者判断放哪更合理）、`web/src/store/projects.ts`

- 一个滑块，标签「字幕高度」
- **实时预览**：拖动时 JASSUB 应该跟着变。ASS 是从接口取的，所以拖完要重新拉一次 `subtitles.ass`——**加防抖**，别每移动 1px 就发一次请求
- 显示当前值，但**不要显示像素数**——用户不关心 120 还是 160。用相对说法（"偏下 / 居中偏下 / 偏上"）或者干脆只有滑块没有数字
- 放哪：字幕相关的设置理应靠近字幕。但字幕列表在左栏、预览在右栏，而这个参数是**看着预览调的**——放右栏预览下方更顺手。实现者定，在报告里说明理由

---

## 完成标准

- [ ] 拖滑块，预览里字幕位置实时变
- [ ] 导出的成片位置与预览一致
- [ ] 免责声明不跟着动
- [ ] 已有项目（含 陈梓昂 名下的）观感不变
- [ ] 极端值不会让字幕跑到画外
- [ ] `npm test` 全绿
