# 自备配音 + 字幕（拖拽导入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 用户手里已经有配好的音频和字幕文件时，直接拖进来用，跳过 AI 配音。

**Architecture:** 复用早就写好的 `parseSrt()`（645 条 cue + BOM 已测）。上传的 SRT 解析成 `SubtitleLine[]`，展平成项目的 `wordTimingsJson`；配音时长用 ffprobe 量。整条下游管线（字幕派生接口、预览、导出、背景排布）**零改动**——它们只认 `wordTimingsJson` + `ttsDurationMs`，不关心这两样是 Azure 生成的还是用户传的。

**Tech Stack:** TypeScript / Fastify / better-sqlite3 / ffprobe / React 19 / Zustand / vitest

## Global Constraints

- 测试框架 **vitest**；`npm test` 先跑 `tsc --noEmit && tsc -b web`。**当前基线 436 个测试**
- **每个 `expect(...)` 必须接 matcher**，否则假绿
- tsconfig 开了 **noUncheckedIndexedAccess**，`arr[0].field` 过不了；**不要用 `!` 绕过**
- **不要用 `as XxxType` 硬转造测试数据**——踩过：`fitMode` 误写成 `fit`，类型检查一声不吭，跑到 ffmpeg 才炸
- **时长必须是整数毫秒**。踩过：Azure 的 HNS 除以 10000 出小数（65087.5），背景排布直接 500。ffprobe 那条路径 `probeDurationMs` 已经 `Math.round` 过，别再引入新的小数源
- **不要用 emoji**；图标用 `web/src/components/ui/Icon.tsx` 的 SVG（1.5 描边圆头）
- **不引入新颜色**，只用 `ink-950..50` + `accent`（琥珀金 #f0b429）

---

## 一个必须讲清楚的限制

**自备 SRT 做不了逐字卡拉OK。** SRT 是句级时间戳，格式本身就没有字级信息。

现有设计已经把这条路留好了：`parseSrt()` 把每条 cue 的整句塞进**一个**"词"里（`words` 长度恒为 1），配合 `buildAss` 的**整句模式**渲染；项目表也早有 `subtitle_mode` 列。

所以两条来源天然分流：

| 来源 | 时间精度 | subtitle_mode |
|---|---|---|
| AI 配音 | 词级 | `karaoke`（逐字扫光） |
| 自备 SRT | 句级 | `line`（整句显示） |

**界面上必须说明这一点**，否则用户传完 SRT 发现没有扫光，会以为坏了。

**绝不要对 SRT 结果再跑 `segmentLines`**——那是给词级时间轴断句用的，SRT 已经是用户/剪辑软件断好的分行，重断会破坏原有分行。`srt.ts` 的注释里写了这条。

---

### Task 1: 上传接口接受 voice / srt

**Files:** `src/assets/routes.ts`、`src/assets/storage.ts`、`tests/assets/*`

- `kind` 白名单从 `video|bgm` 扩到 `video|bgm|voice|srt`
- 扩展名校验（`isAllowedExt`）补：`voice` → `.mp3/.wav/.m4a/.aac`，`srt` → `.srt`
- **SRT 不是媒体文件，不要对它跑 ffprobe**——现有上传路径会探测时长，srt 要跳过
- 同一项目重复传同一种 kind：**替换而非追加**。配音和字幕各自只能有一份，追加会让下游不知道用哪个

测试覆盖：四种 kind 都能传、错误扩展名被拒、srt 不触发 ffprobe、重复传是替换。

---

### Task 2: 从 SRT 派生项目状态

**Files:** `src/subtitles/from-srt.ts`（新）、`src/projects/routes.ts`、测试

新增 `POST /api/projects/:id/adopt-srt`（或在上传完 srt 后自动触发，实现者定，在报告里说明选择）：

1. 读该项目的 `srt` 素材，`parseSrt()` 解析
2. 展平成 `WordTiming[]` 存进 `wordTimingsJson`
3. 读 `voice` 素材，`probeDurationMs()` 量时长存进 `ttsDurationMs`
4. `ttsState` 置 `ready`，`subtitle_mode` 置 `line`

**前置校验要给出可操作的错误**，不要笼统的 400：
- 只有 SRT 没有配音 → 「还差配音文件」
- 只有配音没有 SRT → 「还差字幕文件」
- SRT 解析出 0 条 cue → 「字幕文件解析不出内容，确认是标准 SRT 格式」
- **SRT 最后一条 cue 的结束时间明显超过配音时长** → 警告但不阻断（用户可能传错配对的文件，但也可能只是尾部留白）

**这一步之后，下游全部零改动**：字幕派生接口、JASSUB 预览、背景排布、导出，都只认 `wordTimingsJson` + `ttsDurationMs`。要在测试里**断言这一点**——用自备路径建的项目，`GET /api/projects/:id/subtitles` 和 `background-plan` 都要正常返回。

---

### Task 3: 前端拖拽区

**Files:** `web/src/components/VoicePanel.tsx`、`web/src/store/pipeline.ts`、测试

配音区（现在在字幕列表上方）加两条路：

```
配音
┌─────────────────────────────────────┐
│  [生成配音]   或把配音和字幕文件拖到这里 │
└─────────────────────────────────────┘
   支持 mp3/wav + srt · 自备字幕为整句显示，无逐字高亮
```

- 整个配音区作为拖放目标，拖入时**整区高亮**（`accent` 低透明度描边），不要只在一个小方块上响应
- 一次可以拖入两个文件（音频 + srt），**按扩展名自动分辨哪个是哪个**，不要让用户分别拖
- 只拖了一个时，显示还差什么（「已收到配音，还差字幕文件」）
- **必须同时有 `dragover` 的 `preventDefault`**，否则浏览器会直接打开文件、当前页面丢失
- 传完自动触发 Task 2 的派生，成功后字幕列表立刻有内容
- **整句模式的说明要在界面上**，不能只写在文档里

**这里【可以】有上传**——它和素材栏不同。素材栏是本地素材库（`data/library/`，用户只能选不能传）；配音和字幕是用户自己的内容，本来就该能传。两者别混。

---

## 完成标准

- [ ] 拖一个 mp3 + 一个 srt 进去，字幕列表立刻有内容
- [ ] 预览能播，字幕整句显示（不是逐字，且界面说明了原因）
- [ ] 导出的成片字幕正确，背景公式照常工作
- [ ] 只拖一个文件时，提示还差什么
- [ ] 错误的文件类型被拒且说清原因
- [ ] 素材栏仍然没有任何上传
- [ ] `npm test` 全绿
