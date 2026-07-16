# SureJack 阶段 1：生成管线（无界面） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一条命令，给它文案和背景视频，端到端产出成片——把阶段 0 手搓的一次性脚本变成有边界、有测试的正经模块。

**Architecture:** 五个模块，每个一个明确职责，通过纯数据结构通信：`importers`（任意格式 → 干净 UTF-8 文本）→ `tts`（文本 → 音频 + 词级时间戳）→ `subtitles`（时间戳 → ASS，**纯函数**）→ `render`（构造 ffmpeg 命令并执行）。`cli` 把它们串起来。**没有 HTTP、没有数据库、没有界面**——这一阶段的产物是一个可测试的库加一个 CLI。

**Tech Stack:** Node 24 LTS、TypeScript、vitest、`microsoft-cognitiveservices-speech-sdk`、`chardet` + `iconv-lite`、`mammoth`、`catdoc`（外部命令）、`ffmpeg`（外部命令，`child_process.spawn` 直调）

> ## ⚠️ 本阶段明确不做的（不是遗漏，是划界）
>
> - **多片段拼接** —— 数据模型（`Clip[]`）留好了，但 `render` 目前**只支持单片段**，传多个会**显式报错而不是悄悄出错**。原因：多片段需要两趟渲染（ffmpeg 的 `loop` 滤镜按帧工作、吃内存，而 `-stream_loop` 只能作用于输入文件，没法作用于 concat 的结果）。这是设计文档第 10 节的「慢路径」，留到阶段 3 之前补。**阶段 0 的 demo 也只用了单片段，所以这条路径从未被验证过。**
> - **HTTP、数据库、认证、界面** —— 那是阶段 2 和 3。本阶段的产物是一个库加一个 CLI。
> - **字幕手动调时间/断句** —— 设计文档第 17 节已主动拒绝。

## Global Constraints

以下每一条都来自设计文档或阶段 0 的实测，**违反任何一条都会产生难查的 bug**：

- **Node 24 LTS**。当前系统是 20.20.2，**已于 2026-04-30 EOL**，必须升级。
- **ASS 字体族名必须精确是 `Noto Sans CJK SC`**，不是 `Noto Sans SC`。写错的表现是**字幕渲染成方块或完全不显示，且 ffmpeg 不报错**（`fc-match` 找不到时静默回退到无中文字形的 DejaVu Sans）。必须是配置常量，且启动时校验。
- **fontsdir**：`/usr/share/fonts/opentype/noto`
- **`\kf` 按「词」分组，不按「字」**。Azure 给的是词级时间戳（「震惊」是一个整词）。
- **`\kf` 时长要覆盖到下一个词的起点**，不是本词的 duration——否则词间空隙会让扫光与音频脱节。
- **必须反转义 XML 实体**：Azure 的 `WordBoundary` 返回的 `text` 是转义后的形态（`&` → `&amp;`）。不处理的话字幕会字面显示 `&amp;`。
- **不要用 `textOffset`**：它指向 SSML 字符串位置而非原文，转义会让偏移错位。只用 `e.text`。
- **`audioOffset` 单位是 100 纳秒（HNS），除以 10000 得毫秒**。
- **TTS 整篇一次合成，绝不逐句请求**。F0 限速 **20 次请求/60 秒**，单次最长 10 分钟音频。
- **`catdoc` 会静默失败**：喂非 `.doc` 文件时吐乱码却返回退出码 0。**必须做基于内容的校验，不能只看退出码。**
- **`antiword` 已出局**（中文 `.doc` 直接崩溃）。
- **ffmpeg 输出必须 `-pix_fmt yuv420p`**，否则部分播放器和平台无法播放。
- **`fluent-ffmpeg` 已归档废弃**，用 `child_process.spawn` 直调。
- 时间永远由配音推导，**不存字幕行**（推导数据不入库，见设计文档第 4 节）。

---

## 文件结构

```
package.json                    # Node 24、type: module、vitest
tsconfig.json
src/
├── config.ts                   # 字体族名、fontsdir、画幅预设——静默失败的东西必须集中且可校验
├── types.ts                    # 跨模块的数据结构，唯一真相
├── importers/
│   ├── sanitize.ts             # XML 实体清洗 + 空白压缩
│   ├── txt.ts                  # 编码探测 + 转 UTF-8
│   ├── docx.ts                 # mammoth
│   ├── doc.ts                  # catdoc + 内容校验（防静默失败）
│   └── index.ts                # 按扩展名分发
├── tts/
│   ├── azure.ts                # Azure SDK 实现
│   └── index.ts                # 可替换接口——换服务商只动这里
├── subtitles/
│   ├── segment.ts              # 断句：词 → 行（纯函数，主战场）
│   ├── ass.ts                  # 生成 ASS 文本（纯函数）
│   └── index.ts
├── render/
│   ├── filters.ts              # 滤镜链构造（纯函数，好测）
│   ├── ffmpeg.ts               # 执行 + 进度解析
│   └── index.ts
└── cli.ts                      # 端到端命令行
tests/
├── importers/{sanitize,txt,doc}.test.ts
├── subtitles/{segment,ass}.test.ts
└── render/filters.test.ts
```

**为什么这样切**：`subtitles/` 和 `render/filters.ts` 是**纯函数、无 IO**，是测试的主战场，也是最容易出错的地方（断句边界、时间计算、滤镜拼接）。`tts/` 和 `render/ffmpeg.ts` 碰外部世界，测试用打桩和小样本。

---

## Task 1: 项目骨架与配置

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/config.ts`, `src/types.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `FONT_FAMILY`、`FONTS_DIR`、`ASPECT_PRESETS`、`assertFontAvailable()`；以及 `types.ts` 里的全部类型（后续每个任务都依赖）

- [ ] **Step 1: 升级 Node 到 24 LTS**

系统当前是 20.20.2（已 EOL）。用 nvm 装，**不动系统 Node**——这台机器上跑着 `plus` 生产服务（虽然它是 Python，但不冒险）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 24
node -v
```

Expected: `v24.x.x`

- [ ] **Step 2: 初始化项目**

```bash
cd /root/SureJack
npm init -y
npm pkg set type=module name=surejack
npm pkg set engines.node=">=24"
npm install typescript tsx vitest @types/node --save-dev
npm install microsoft-cognitiveservices-speech-sdk chardet iconv-lite mammoth
npm pkg set scripts.test="vitest run"
npm pkg set scripts.cli="tsx src/cli.ts"
```

创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

创建 `vitest.config.ts`：

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

- [ ] **Step 3: 写 types.ts**

这是跨模块的唯一真相。所有模块只通过这些结构通信：

```typescript
/** Azure WordBoundary 事件，已归一化：偏移量单位是毫秒，文本已反转义 */
export interface WordTiming {
  text: string
  offsetMs: number
  durationMs: number
  isPunctuation: boolean
}

/** TTS 结果。时间的唯一来源。 */
export interface TtsResult {
  audioPath: string
  durationMs: number
  words: WordTiming[]
}

/** 一行字幕。推导数据——不入库，每次从 WordTiming 算出来。 */
export interface SubtitleLine {
  startMs: number
  endMs: number
  words: WordTiming[]
}

export type FitMode = 'cover' | 'contain' | 'blur'

/** 一个背景视频片段 */
export interface Clip {
  path: string
  fitMode: FitMode
  /** 裁切窗口中心在源画面中的归一化位置，0..1，默认 0.5。仅 cover 模式有意义 */
  cropOffsetX: number
  cropOffsetY: number
  /** 源视频自身的裁剪，用于切掉烧死的字幕等。可空 */
  sourceCrop?: { w: number; h: number; x: number; y: number }
}

/** 固定位置文本：标题、免责声明。与字幕共用一个 ASS 文件 */
export interface TextOverlay {
  content: string
  style: 'Title' | 'Disclaimer'
  /** null = 全程常驻 */
  startMs: number | null
  endMs: number | null
}

export interface AspectPreset {
  name: string
  width: number
  height: number
}

/** 渲染作业的完整描述 */
export interface RenderJob {
  clips: Clip[]
  voicePath: string
  bgmPath?: string
  bgmVolume: number
  assPath: string
  aspect: AspectPreset
  durationMs: number
  outPath: string
}
```

- [ ] **Step 4: 写 config.ts**

```typescript
import { execFileSync } from 'node:child_process'
import type { AspectPreset } from './types.js'

/**
 * ⚠️ 必须精确是 'Noto Sans CJK SC'，不是 'Noto Sans SC'。
 * fc-match 找不到族名时会【静默回退】到 DejaVu Sans（零个中文字形），
 * 表现是字幕渲染成方块或完全不显示，而 ffmpeg 不报任何错误。
 * 已在阶段 0 踩过，见 docs/superpowers/spikes/RESULTS.md。
 */
export const FONT_FAMILY = 'Noto Sans CJK SC'
export const FONTS_DIR = '/usr/share/fonts/opentype/noto'

export const ASPECT_PRESETS: Record<string, AspectPreset> = {
  '9:16': { name: '9:16', width: 1080, height: 1920 },
  '4:5': { name: '4:5', width: 1080, height: 1350 },
  '1:1': { name: '1:1', width: 1080, height: 1080 },
  '16:9': { name: '16:9', width: 1920, height: 1080 },
}

/**
 * 启动时校验字体真的可解析。
 * 静默失败的东西必须主动探测——这正是本项目踩过的坑。
 */
export function assertFontAvailable(): void {
  let out: string
  try {
    out = execFileSync('fc-match', [FONT_FAMILY], { encoding: 'utf-8' })
  } catch {
    throw new Error('fc-match 不可用，无法校验字体。请确认已安装 fontconfig')
  }
  if (!out.includes(FONT_FAMILY)) {
    throw new Error(
      `字体族名 "${FONT_FAMILY}" 解析失败，fc-match 回退到了：${out.trim()}\n` +
      `请安装 fonts-noto-cjk：sudo apt-get install -y fonts-noto-cjk`
    )
  }
}
```

- [ ] **Step 5: 写测试**

创建 `tests/config.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { FONT_FAMILY, ASPECT_PRESETS, assertFontAvailable } from '../src/config.js'

describe('config', () => {
  it('字体族名是 Noto Sans CJK SC，不是 Noto Sans SC', () => {
    // 这个断言存在的意义：防止有人"顺手改回"看起来更合理的那个名字
    expect(FONT_FAMILY).toBe('Noto Sans CJK SC')
  })

  it('字体在本机可解析', () => {
    expect(() => assertFontAvailable()).not.toThrow()
  })

  it('竖屏预设是 1080x1920', () => {
    expect(ASPECT_PRESETS['9:16']).toEqual({ name: '9:16', width: 1080, height: 1920 })
  })
})
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run tests/config.test.ts`
Expected: 3 passed

- [ ] **Step 7: 提交**

```bash
git add package.json tsconfig.json vitest.config.ts src/config.ts src/types.ts tests/config.test.ts
git commit -m "feat: 项目骨架、跨模块类型与配置

字体族名做成常量并加启动校验——阶段 0 踩过的坑：写错族名时
fc-match 静默回退，字幕不显示且 ffmpeg 不报错。"
```

---

## Task 2: importers/sanitize —— 文本清洗

**Files:**
- Create: `src/importers/sanitize.ts`
- Test: `tests/importers/sanitize.test.ts`

**Interfaces:**
- Produces: `unescapeXml(s: string): string`、`normalizeScript(s: string): string`

- [ ] **Step 1: 写失败的测试**

创建 `tests/importers/sanitize.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { unescapeXml, normalizeScript } from '../../src/importers/sanitize.js'

describe('unescapeXml', () => {
  it('还原 Azure WordBoundary 返回的转义实体', () => {
    // 实测：输入 A&B，Azure 事件的 text 回来是 &amp; 而非 &
    expect(unescapeXml('&amp;')).toBe('&')
    expect(unescapeXml('&lt;')).toBe('<')
    expect(unescapeXml('&gt;')).toBe('>')
    expect(unescapeXml('&quot;')).toBe('"')
    expect(unescapeXml('&apos;')).toBe("'")
  })

  it('不碰普通文本', () => {
    expect(unescapeXml('震惊！这个方法')).toBe('震惊！这个方法')
  })

  it('&amp;amp; 只还原一层，不重复解码', () => {
    // 重复解码会把 &amp;lt; 变成 <，那是注入风险
    expect(unescapeXml('&amp;amp;')).toBe('&amp;')
  })
})

describe('normalizeScript', () => {
  it('把连续空白压成单空格，保留标点', () => {
    expect(normalizeScript('老陈是在星期八醒来的。\n\n他决定去买包子。'))
      .toBe('老陈是在星期八醒来的。 他决定去买包子。')
  })

  it('去掉首尾空白', () => {
    expect(normalizeScript('  包子  ')).toBe('包子')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/importers/sanitize.test.ts`
Expected: FAIL —— `Cannot find module '../../src/importers/sanitize.js'`

- [ ] **Step 3: 实现**

创建 `src/importers/sanitize.ts`：

```typescript
/**
 * 还原 XML 实体。
 *
 * 为什么需要：Azure 的 SDK 把文本包进 SSML 时做 XML 转义，
 * 而 WordBoundary 事件报告的是【转义后】的形态——输入 A&B，
 * 事件的 text 回来是 '&amp;'。不还原的话字幕会字面显示 &amp;。
 * 已实测，见 docs/superpowers/spikes/RESULTS.md。
 *
 * 用单次 replace 而非链式：链式会把 &amp;lt; 二次解码成 <。
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

export function unescapeXml (s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
}

/**
 * 归一化文案：连续空白（含换行）压成单空格。
 *
 * 为什么：段落间的空行会让 TTS 产生过长停顿。标点保留——
 * 它们是断句的依据，而且 Azure 会为标点单独触发事件。
 */
export function normalizeScript (s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/importers/sanitize.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/importers/sanitize.ts tests/importers/sanitize.test.ts
git commit -m "feat: 文本清洗——XML 实体还原与空白归一化

Azure 的 WordBoundary 返回转义后的文本（& → &amp;），
不还原的话字幕会字面显示实体码。已实测确认。"
```

---

## Task 3: importers/txt —— 编码探测

**中文 txt 大量是 GBK/GB18030，按 UTF-8 硬读必然满屏乱码。** 这是必坏的，不是可能坏。

**Files:**
- Create: `src/importers/txt.ts`
- Test: `tests/importers/txt.test.ts`

**Interfaces:**
- Consumes: `normalizeScript` from `src/importers/sanitize.ts`
- Produces: `importTxt(buf: Buffer): { text: string; encoding: string; confidence: number }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/importers/txt.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { importTxt } from '../../src/importers/txt.js'

const CN = '震惊！这个方法99%的人都不知道，AI一秒搞定。'

describe('importTxt', () => {
  it('读 UTF-8', () => {
    const r = importTxt(Buffer.from(CN, 'utf-8'))
    expect(r.text).toBe(CN)
  })

  it('读 GBK——中文 txt 的常见编码，按 UTF-8 硬读会乱码', () => {
    const r = importTxt(iconv.encode(CN, 'gbk'))
    expect(r.text).toBe(CN)
  })

  it('读 GB18030', () => {
    const r = importTxt(iconv.encode(CN, 'gb18030'))
    expect(r.text).toBe(CN)
  })

  it('剥掉 UTF-8 BOM——Windows 记事本会加，不剥的话首字符是不可见的 \\uFEFF', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CN, 'utf-8')])
    expect(importTxt(withBom).text).toBe(CN)
  })

  it('报告探测到的编码与置信度', () => {
    const r = importTxt(iconv.encode(CN, 'gbk'))
    expect(r.encoding.toLowerCase()).toMatch(/gb/)
    expect(r.confidence).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/importers/txt.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/importers/txt.ts`：

```typescript
import chardet from 'chardet'
import iconv from 'iconv-lite'
import { normalizeScript } from './sanitize.js'

/**
 * 读 txt，自动探测编码。
 *
 * 为什么必须做：中文 txt 在国内大量是 GBK / GB18030，
 * 按 UTF-8 硬读会得到满屏乱码——而且是"文件传上去了、项目也建了、
 * 就是文字全是问号"这种最难受的失败。
 */
export function importTxt (buf: Buffer): { text: string; encoding: string; confidence: number } {
  const matches = chardet.analyse(buf)
  const best = matches[0]
  const encoding = best?.name ?? 'UTF-8'
  const confidence = best?.confidence ?? 0

  const decoded = iconv.decodingExists(encoding)
    ? iconv.decode(buf, encoding)
    : buf.toString('utf-8')

  // 剥 BOM：Windows 记事本存 UTF-8 会加，不剥的话首字符是不可见的 ﻿，
  // 它会混进第一行字幕，也会让 TTS 多念一个空
  const text = decoded.replace(/^﻿/, '')

  return { text: normalizeScript(text), encoding, confidence }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/importers/txt.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/importers/txt.ts tests/importers/txt.test.ts
git commit -m "feat: txt 导入——编码探测与转码

中文 txt 大量是 GBK/GB18030，按 UTF-8 硬读必然乱码。
同时剥 BOM——记事本存的 UTF-8 会加，不剥会混进第一行字幕。"
```

---

## Task 4: importers/doc —— catdoc 与静默失败检测

**catdoc 会在明显失败时返回退出码 0 并吐乱码**（阶段 0 实测）。这个任务的核心不是"能不能解析"，而是**"失败能不能被发现"**。

**Files:**
- Create: `src/importers/doc.ts`, `src/importers/docx.ts`
- Test: `tests/importers/doc.test.ts`

**Interfaces:**
- Consumes: `normalizeScript` from `src/importers/sanitize.ts`
- Produces: `looksLikeMojibake(s: string): boolean`、`importDoc(path: string): Promise<string>`、`importDocx(buf: Buffer): Promise<string>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/importers/doc.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { looksLikeMojibake } from '../../src/importers/doc.js'

describe('looksLikeMojibake', () => {
  it('正常中文不是乱码', () => {
    expect(looksLikeMojibake('震惊！这个方法99%的人都不知道')).toBe(false)
  })

  it('正常英文不是乱码', () => {
    expect(looksLikeMojibake('This is a normal English sentence.')).toBe(false)
  })

  it('识别 UTF-8 被当 cp1252 读出来的乱码', () => {
    // 这是 catdoc 静默失败时的实际输出形态（阶段 0 实测）
    expect(looksLikeMojibake('è¿™ä¸æ˜¯ä¸€ä¸ªçœŸæ£çš„ doc æ–‡ä»¶')).toBe(true)
  })

  it('识别 GBK 被当 latin1 读出来的乱码', () => {
    expect(looksLikeMojibake('Õð¾ª£¡Õâ¸ö·½·¨99%µÄÈË¶¼²»ÖªµÀ')).toBe(true)
  })

  it('空字符串算失败', () => {
    expect(looksLikeMojibake('')).toBe(true)
  })

  it('少量重音字母不误判——法语人名不该被当成乱码', () => {
    expect(looksLikeMojibake('André 是一个法国人的名字，他今天来买包子。')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/importers/doc.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/importers/doc.ts`：

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeScript } from './sanitize.js'

const exec = promisify(execFile)

/**
 * 启发式判断抽取结果是不是乱码。
 *
 * 为什么必须有：catdoc【会静默失败】——喂它一个非 .doc 文件，
 * 它吐出乱码却返回退出码 0（阶段 0 实测）。所以退出码完全不能信。
 * 乱码悄悄流进配音环节，用户会拿到一条念着乱码的视频——
 * 比直接报错糟糕得多。
 *
 * 判据：乱码的典型形态是 UTF-8/GBK 字节被按单字节编码解读，
 * 产出大量 Latin-1 补充区字符（À-ÿ）。正常文本里这类字符很少。
 */
export function looksLikeMojibake (s: string): boolean {
  const text = s.trim()
  if (text.length === 0) return true

  const chars = [...text]
  const latin1Supplement = chars.filter((c) => {
    const cp = c.codePointAt(0)!
    return cp >= 0xc0 && cp <= 0xff
  }).length

  // 正常中文/英文里 À-ÿ 占比极低；乱码里能占到三成以上。
  // 阈值 15% 给法语人名之类的正常用法留了余量。
  return latin1Supplement / chars.length > 0.15
}

/**
 * 用 catdoc 抽取 .doc 文本。
 *
 * antiword 已出局——对中文 .doc 直接崩溃（阶段 0 实测）。
 * .doc 支持是【尽力而为】的降级路径：读不出来就明确拒绝，绝不假装成功。
 */
export async function importDoc (path: string): Promise<string> {
  let stdout: string
  try {
    const r = await exec('catdoc', ['-d', 'utf-8', path], { maxBuffer: 32 * 1024 * 1024 })
    stdout = r.stdout
  } catch (e) {
    throw new Error(
      `.doc 解析失败：${(e as Error).message}\n` +
      '请在 Word 里另存为 .docx 后重新上传。'
    )
  }

  const text = normalizeScript(stdout)

  // 退出码是 0 也不能信——必须看内容
  if (looksLikeMojibake(text)) {
    throw new Error(
      '.doc 解析出来是乱码（这个老格式的中文编码支持不可靠）。\n' +
      '请在 Word 里另存为 .docx 后重新上传。'
    )
  }

  return text
}
```

创建 `src/importers/docx.ts`：

```typescript
import mammoth from 'mammoth'
import { normalizeScript } from './sanitize.js'

/** .docx 是 zip + XML，解析成熟，没有 .doc 那些编码问题 */
export async function importDocx (buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  const text = normalizeScript(value)
  if (text.length === 0) throw new Error('.docx 里没有提取到文本')
  return text
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/importers/doc.test.ts`
Expected: 6 passed

- [ ] **Step 5: 用真实的 .doc 端到端验证**

阶段 0 已经生成过样本。确认真能读：

```bash
npx tsx -e "
import { importDoc } from './src/importers/doc.js'
const t = await importDoc('spikes/doc-parse/samples/sample.doc')
console.log('读出：', t.slice(0, 40))
"
```

Expected: 打印出可读的中文，例如 `读出： 震惊！这个方法99%的人都不知道 很多人每天花3个小时剪视频...`

如果 `spikes/doc-parse/samples/sample.doc` 不存在，先跑 `./spikes/doc-parse/make-sample.sh` 生成。

- [ ] **Step 6: 验证静默失败真的被拦住**

```bash
echo "这不是一个真正的 doc 文件" > /tmp/fake.doc
npx tsx -e "
import { importDoc } from './src/importers/doc.js'
try { await importDoc('/tmp/fake.doc'); console.log('❌ 没拦住！') }
catch (e) { console.log('✅ 拦住了：', e.message.split('\n')[0]) }
"
```

Expected: `✅ 拦住了： .doc 解析出来是乱码（这个老格式的中文编码支持不可靠）。`

**这一步是本任务的重点。** catdoc 对这个文件返回退出码 0，如果只看退出码就会放行。

- [ ] **Step 7: 提交**

```bash
git add src/importers/doc.ts src/importers/docx.ts tests/importers/doc.test.ts
git commit -m "feat: .doc/.docx 导入，含静默失败检测

catdoc 会在明显失败时返回退出码 0 并吐乱码（阶段 0 实测），
所以必须做基于内容的校验——用 Latin-1 补充区字符占比判断乱码。
antiword 已出局：对中文 .doc 直接崩溃。"
```

---

## Task 5: importers/index —— 按格式分发

**Files:**
- Create: `src/importers/index.ts`
- Test: `tests/importers/index.test.ts`

**Interfaces:**
- Consumes: `importTxt`、`importDoc`、`importDocx`
- Produces: `importScript(path: string): Promise<string>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/importers/index.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import iconv from 'iconv-lite'
import { importScript } from '../../src/importers/index.js'

describe('importScript', () => {
  it('按扩展名分发 .txt，并正确处理 GBK', () => {
    writeFileSync('/tmp/t.txt', iconv.encode('震惊！包子', 'gbk'))
    return expect(importScript('/tmp/t.txt')).resolves.toBe('震惊！包子')
  })

  it('拒绝不支持的格式，并说明支持哪些', async () => {
    writeFileSync('/tmp/t.pdf', 'x')
    await expect(importScript('/tmp/t.pdf')).rejects.toThrow(/不支持.*pdf/)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/importers/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/importers/index.ts`：

```typescript
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { importTxt } from './txt.js'
import { importDoc } from './doc.js'
import { importDocx } from './docx.js'

export { unescapeXml, normalizeScript } from './sanitize.js'

/**
 * 把任意支持的格式变成干净的 UTF-8 文本。
 *
 * 外界不需要知道文件格式的存在——编码探测、格式解析、
 * 失败检测全在这个模块里解决。
 */
export async function importScript (path: string): Promise<string> {
  const ext = extname(path).toLowerCase()

  switch (ext) {
    case '.txt':
      return importTxt(await readFile(path)).text
    case '.docx':
      return importDocx(await readFile(path))
    case '.doc':
      return importDoc(path)   // catdoc 直接读文件，不经 Buffer
    default:
      throw new Error(`不支持的格式：${ext || '(无扩展名)'}。支持 .txt / .docx / .doc，也可以直接粘贴文案。`)
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/importers/index.test.ts`
Expected: 2 passed

- [ ] **Step 5: 提交**

```bash
git add src/importers/index.ts tests/importers/index.test.ts
git commit -m "feat: 导入分发——文件格式对外部不可见"
```

---

## Task 6: subtitles/segment —— 断句（纯函数，主战场）

**Files:**
- Create: `src/subtitles/segment.ts`
- Test: `tests/subtitles/segment.test.ts`

**Interfaces:**
- Consumes: `WordTiming`、`SubtitleLine` from `src/types.ts`
- Produces: `segmentLines(words: WordTiming[], maxChars: number): SubtitleLine[]`

- [ ] **Step 1: 写失败的测试**

创建 `tests/subtitles/segment.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { segmentLines } from '../../src/subtitles/segment.js'
import type { WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs: number, isPunctuation = false): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation })

describe('segmentLines', () => {
  it('在标点处断行——Azure 单独触发标点事件，断句是白送的', () => {
    const words = [
      w('震惊', 0, 500),
      w('！', 500, 100, true),
      w('包子', 600, 400),
      w('。', 1000, 100, true),
    ]
    const lines = segmentLines(words, 14)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.map((x) => x.text).join('')).toBe('震惊！')
    expect(lines[1]!.words.map((x) => x.text).join('')).toBe('包子。')
  })

  it('标点留在它所属的那一行末尾，不甩到下一行开头', () => {
    const lines = segmentLines([w('好', 0, 100), w('。', 100, 50, true), w('坏', 150, 100)], 14)
    expect(lines[0]!.words.at(-1)!.text).toBe('。')
    expect(lines[1]!.words[0]!.text).toBe('坏')
  })

  it('超过字数上限强制断行——竖屏一行放不下太多字', () => {
    const words = Array.from({ length: 10 }, (_, i) => w('包子', i * 100, 100))
    const lines = segmentLines(words, 6)   // 每行最多 6 字 = 3 个「包子」
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      const chars = line.words.reduce((n, x) => n + [...x.text].length, 0)
      expect(chars).toBeLessThanOrEqual(6)
    }
  })

  it('行的起止时间完全由时间戳推导——首词起点到末词终点', () => {
    const lines = segmentLines([w('老陈', 250, 500), w('。', 750, 100, true)], 14)
    expect(lines[0]!.startMs).toBe(250)
    expect(lines[0]!.endMs).toBe(850)   // 750 + 100
  })

  it('空输入返回空数组，不崩', () => {
    expect(segmentLines([], 14)).toEqual([])
  })

  it('没有标点的长文本也能靠字数上限断开，不会产出一行超长字幕', () => {
    const words = Array.from({ length: 20 }, (_, i) => w('字', i * 100, 100))
    const lines = segmentLines(words, 5)
    expect(lines).toHaveLength(4)
  })

  it('末尾没有标点时也要 flush，不丢最后一行', () => {
    const lines = segmentLines([w('包子', 0, 500)], 14)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.words[0]!.text).toBe('包子')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/subtitles/segment.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/subtitles/segment.ts`：

```typescript
import type { WordTiming, SubtitleLine } from '../types.js'

/**
 * 把词级时间戳切成字幕行。
 *
 * 规则（设计文档第 7 节）：
 *   - 标点是天然断句点——Azure 会为标点单独触发事件，我们不用碰中文分词
 *   - 字数上限兜底，避免竖屏放不下
 *   - 行的起止时间【完全由时间戳推导】，从不手动指定：
 *     时间永远是配音的函数，只有一个真相来源
 *
 * 这是纯函数：无 IO、无状态。结果是推导数据，不入库。
 */
export function segmentLines (words: WordTiming[], maxChars: number): SubtitleLine[] {
  const lines: SubtitleLine[] = []
  let cur: WordTiming[] = []

  const flush = (): void => {
    if (cur.length === 0) return
    const first = cur[0]!
    const last = cur[cur.length - 1]!
    lines.push({
      startMs: first.offsetMs,
      endMs: last.offsetMs + last.durationMs,
      words: cur,
    })
    cur = []
  }

  for (const word of words) {
    cur.push(word)

    // 标点断行：标点留在本行末尾
    if (word.isPunctuation) { flush(); continue }

    const chars = cur.reduce((n, x) => n + [...x.text].length, 0)
    if (chars >= maxChars) flush()
  }

  flush()   // 末尾没有标点时也要收尾，否则丢最后一行
  return lines
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/subtitles/segment.test.ts`
Expected: 7 passed

- [ ] **Step 5: 提交**

```bash
git add src/subtitles/segment.ts tests/subtitles/segment.test.ts
git commit -m "feat: 断句——标点边界 + 字数上限

行的起止时间完全由时间戳推导，从不手动指定：
时间永远是配音的函数，只有一个真相来源。"
```

---

## Task 7: subtitles/ass —— 生成 ASS（纯函数）

**Files:**
- Create: `src/subtitles/ass.ts`, `src/subtitles/index.ts`
- Test: `tests/subtitles/ass.test.ts`

**Interfaces:**
- Consumes: `SubtitleLine`、`TextOverlay`、`AspectPreset`、`FONT_FAMILY`、`segmentLines`
- Produces: `formatAssTime(ms: number): string`、`buildKaraoke(line: SubtitleLine): string`、`buildAss(opts: BuildAssOptions): string`；`BuildAssOptions = { lines: SubtitleLine[]; overlays: TextOverlay[]; aspect: AspectPreset; durationMs: number; mode: 'line' | 'karaoke' }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/subtitles/ass.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { formatAssTime, buildKaraoke, buildAss } from '../../src/subtitles/ass.js'
import { ASPECT_PRESETS, FONT_FAMILY } from '../../src/config.js'
import type { SubtitleLine, WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs: number, isPunctuation = false): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation })

describe('formatAssTime', () => {
  it('格式是 H:MM:SS.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(1500)).toBe('0:00:01.50')
    expect(formatAssTime(61230)).toBe('0:01:01.23')
    expect(formatAssTime(3661000)).toBe('1:01:01.00')
  })

  it('负数夹到 0，不产出非法时间码', () => {
    expect(formatAssTime(-100)).toBe('0:00:00.00')
  })
})

describe('buildKaraoke', () => {
  it('\\kf 时长覆盖到下一个词的起点，不是本词 duration', () => {
    // 关键：词之间有空隙。若用本词 duration，扫光会在空隙处停顿、与音频脱节。
    const line: SubtitleLine = {
      startMs: 0, endMs: 1000,
      words: [w('震惊', 0, 400), w('包子', 500, 500)],
    }
    // 第一个词：500-0 = 500ms = 50cs（覆盖了 100ms 空隙），不是 40cs
    expect(buildKaraoke(line)).toBe('{\\kf50}震惊{\\kf50}包子')
  })

  it('最后一个词用自己的 duration', () => {
    const line: SubtitleLine = { startMs: 0, endMs: 400, words: [w('包子', 0, 400)] }
    expect(buildKaraoke(line)).toBe('{\\kf40}包子')
  })

  it('按词分组，不按字——Azure 给的是词级时间戳', () => {
    const line: SubtitleLine = { startMs: 0, endMs: 500, words: [w('震惊', 0, 500)] }
    // 「震惊」整体一个 \kf，不是 {\kf25}震{\kf25}惊
    expect(buildKaraoke(line)).toBe('{\\kf50}震惊')
  })
})

describe('buildAss', () => {
  const aspect = ASPECT_PRESETS['9:16']!
  const lines: SubtitleLine[] = [{ startMs: 0, endMs: 500, words: [w('包子', 0, 500)] }]

  it('PlayRes 必须等于输出分辨率，否则预览与成片会漂移', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
  })

  it('用正确的字体族名', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain(FONT_FAMILY)
    expect(ass).not.toMatch(/Noto Sans SC,/)   // 那个族名不存在，会静默回退
  })

  it('WrapStyle 是 2——禁用自动换行，绕开 libass 的中文换行问题', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('WrapStyle: 2')
  })

  it('karaoke 模式产出 \\kf 标签', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'karaoke' })
    expect(ass).toContain('{\\kf50}包子')
  })

  it('line 模式不产出 \\kf，只有纯文本', () => {
    const ass = buildAss({ lines, overlays: [], aspect, durationMs: 1000, mode: 'line' })
    expect(ass).not.toContain('\\kf')
    expect(ass).toContain(',,包子')
  })

  it('startMs 为 null 的文本层常驻全程——0 到片尾', () => {
    const ass = buildAss({
      lines, overlays: [{ content: '包子', style: 'Title', startMs: null, endMs: null }],
      aspect, durationMs: 184200, mode: 'karaoke',
    })
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:03:04.20,Title,,0,0,0,,包子')
  })

  it('文本层的 Layer 高于字幕，不会被字幕盖住', () => {
    const ass = buildAss({
      lines, overlays: [{ content: '免责', style: 'Disclaimer', startMs: null, endMs: null }],
      aspect, durationMs: 1000, mode: 'karaoke',
    })
    expect(ass).toMatch(/Dialogue: 1,.*Disclaimer/)   // 文本层 Layer 1
    expect(ass).toMatch(/Dialogue: 0,.*Sub/)          // 字幕 Layer 0
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/subtitles/ass.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/subtitles/ass.ts`：

```typescript
import { FONT_FAMILY } from '../config.js'
import type { SubtitleLine, TextOverlay, AspectPreset } from '../types.js'

export interface BuildAssOptions {
  lines: SubtitleLine[]
  overlays: TextOverlay[]
  aspect: AspectPreset
  durationMs: number
  mode: 'line' | 'karaoke'
}

/** 毫秒 → ASS 时间码 H:MM:SS.cc */
export function formatAssTime (ms: number): string {
  const t = Math.max(0, ms) / 1000
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${h}:${String(m).padStart(2, '0')}:${s}`
}

/**
 * 生成卡拉OK扫光标签。
 *
 * ⚠️ 每个 \kf 的时长要【覆盖到下一个词的起点】，而不是本词的 duration。
 * 词之间存在空隙（停顿），若只用 duration，扫光会在空隙处停住，
 * 与音频脱节——听着念到了下一个词，画面上还没亮。
 *
 * ⚠️ 按【词】分组，不按字。Azure 给的就是词级时间戳（「震惊」是一个整词）。
 */
export function buildKaraoke (line: SubtitleLine): string {
  return line.words.map((word, i) => {
    const next = line.words[i + 1]
    const spanMs = next ? next.offsetMs - word.offsetMs : word.durationMs
    return `{\\kf${Math.round(spanMs / 10)}}${word.text}`   // ASS 的 \k 单位是厘秒
  }).join('')
}

/**
 * 生成完整 ASS：字幕 + 固定文本，同一个文件。
 *
 * 设计文档第 7 节：字幕、标题、免责声明是同一个东西的不同填法，
 * 不需要两套机制。这个文件既喂给 ffmpeg 烧录，也喂给浏览器的 JASSUB 预览——
 * 同一个 libass，所以所见即所得是架构保证的，不是"努力对齐"出来的。
 *
 * 颜色格式是 &HAABBGGRR —— BGR 顺序，不是 RGB。经典陷阱。
 * PrimaryColour = 已唱色，SecondaryColour = 未唱色（不是字面意思上的"主/次"）。
 */
export function buildAss (opts: BuildAssOptions): string {
  const { lines, overlays, aspect, durationMs, mode } = opts

  const dialogues = lines.map((line) => {
    const text = mode === 'karaoke'
      ? buildKaraoke(line)
      : line.words.map((w) => w.text).join('')
    return `Dialogue: 0,${formatAssTime(line.startMs)},${formatAssTime(line.endMs)},Sub,,0,0,0,,${text}`
  })

  // Layer 1 > Layer 0：固定文本压在字幕之上，不会被盖住
  const overlayLines = overlays.map((o) => {
    const start = formatAssTime(o.startMs ?? 0)
    const end = formatAssTime(o.endMs ?? durationMs)
    return `Dialogue: 1,${start},${end},${o.style},,0,0,0,,${o.content}`
  })

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${aspect.width}
PlayResY: ${aspect.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${FONT_FAMILY},64,&H0000E5FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,2,60,60,300,1
Style: Title,${FONT_FAMILY},96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0,100,100,0,0,1,6,0,8,60,60,120,1
Style: Disclaimer,${FONT_FAMILY},32,&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${overlayLines.join('\n')}
${dialogues.join('\n')}
`
}
```

创建 `src/subtitles/index.ts`：

```typescript
export { segmentLines } from './segment.js'
export { buildAss, buildKaraoke, formatAssTime } from './ass.js'
export type { BuildAssOptions } from './ass.js'
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/subtitles/ass.test.ts`
Expected: 10 passed

- [ ] **Step 5: 提交**

```bash
git add src/subtitles/ tests/subtitles/ass.test.ts
git commit -m "feat: ASS 生成——字幕与固定文本共用一个文件

\\kf 时长覆盖到下一个词起点（不是本词 duration），
否则词间空隙会让扫光与音频脱节。按词分组，不按字。"
```

---

## Task 8: render/filters —— 滤镜链构造（纯函数）

滤镜链是最容易出现"差一点"的地方。做成纯函数，测得动。

**Files:**
- Create: `src/render/filters.ts`
- Test: `tests/render/filters.test.ts`

**Interfaces:**
- Consumes: `Clip`、`AspectPreset`、`FitMode`
- Produces: `buildFitFilter(clip: Clip, aspect: AspectPreset, inLabel: string, outLabel: string): string`、`buildAudioFilter(hasBgm: boolean, bgmVolume: number): string`

- [ ] **Step 1: 写失败的测试**

创建 `tests/render/filters.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildFitFilter, buildAudioFilter } from '../../src/render/filters.js'
import { ASPECT_PRESETS } from '../../src/config.js'
import type { Clip } from '../../src/types.js'

const aspect = ASPECT_PRESETS['9:16']!
const clip = (over: Partial<Clip> = {}): Clip => ({
  path: '/tmp/v.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5, ...over,
})

describe('buildFitFilter', () => {
  it('cover 模式：放大到铺满再裁切', () => {
    const f = buildFitFilter(clip(), aspect, '0:v', 'out')
    expect(f).toContain('force_original_aspect_ratio=increase')
    expect(f).toContain('crop=1080:1920')
  })

  it('cover 模式的偏移量：0.5 居中', () => {
    const f = buildFitFilter(clip({ cropOffsetX: 0.5, cropOffsetY: 0.5 }), aspect, '0:v', 'out')
    expect(f).toContain('(iw-ow)*0.5')
    expect(f).toContain('(ih-oh)*0.5')
  })

  it('cover 模式的偏移量：0 靠左上', () => {
    const f = buildFitFilter(clip({ cropOffsetX: 0, cropOffsetY: 0 }), aspect, '0:v', 'out')
    expect(f).toContain('(iw-ow)*0')
  })

  it('contain 模式：完整保留 + 黑边，不裁切', () => {
    const f = buildFitFilter(clip({ fitMode: 'contain' }), aspect, '0:v', 'out')
    expect(f).toContain('force_original_aspect_ratio=decrease')
    expect(f).toContain('pad=1080:1920')
    expect(f).not.toContain('crop=1080:1920')
  })

  it('blur 模式：分流做模糊底 + 前景叠加', () => {
    const f = buildFitFilter(clip({ fitMode: 'blur' }), aspect, '0:v', 'out')
    expect(f).toContain('split=2')
    expect(f).toContain('gblur')
    expect(f).toContain('overlay')
  })

  it('blur 模式先缩小再模糊——直接对 1080x1920 做大 sigma 模糊会慢得离谱', () => {
    const f = buildFitFilter(clip({ fitMode: 'blur' }), aspect, '0:v', 'out')
    // 先 scale 到小尺寸，模糊后再放大——模糊本身掩盖了放大的损失
    expect(f).toMatch(/scale=\d{2,3}:\d{2,3}[^;]*gblur/)
  })

  it('sourceCrop 生效——用于切掉源视频里烧死的字幕', () => {
    const f = buildFitFilter(
      clip({ sourceCrop: { w: 1052, h: 470, x: 0, y: 0 } }), aspect, '0:v', 'out')
    expect(f).toContain('crop=1052:470:0:0')
  })

  it('输入输出标签正确接上', () => {
    const f = buildFitFilter(clip(), aspect, '0:v', 'vout')
    expect(f.startsWith('[0:v]')).toBe(true)
    expect(f.endsWith('[vout]')).toBe(true)
  })
})

describe('buildAudioFilter', () => {
  it('无 BGM 时配音直通', () => {
    const f = buildAudioFilter(false, 0.1)
    expect(f).toContain('[1:a]')
    expect(f).not.toContain('amix')
  })

  it('有 BGM 时混音，且 BGM 按给定音量压低', () => {
    const f = buildAudioFilter(true, 0.1)
    expect(f).toContain('volume=0.1')
    expect(f).toContain('amix=inputs=2')
  })

  it('混音用 normalize=0——否则 amix 会把两轨都压低，配音变小声', () => {
    expect(buildAudioFilter(true, 0.1)).toContain('normalize=0')
  })

  it('混音时长以配音为准——BGM 长了要截断', () => {
    expect(buildAudioFilter(true, 0.1)).toContain('duration=first')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/render/filters.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `src/render/filters.ts`：

```typescript
import type { Clip, AspectPreset } from '../types.js'

/**
 * 构造把一个片段塞进目标画幅的滤镜链。
 *
 * ⚠️ 坐标系必须和前端预览严格一致（设计文档第 15 节风险 5）。
 * cropOffset 的定义：裁切窗口中心在源画面中的归一化位置，0..1。
 */
export function buildFitFilter (
  clip: Clip, aspect: AspectPreset, inLabel: string, outLabel: string,
): string {
  const { width: W, height: H } = aspect

  // 源裁剪：切掉烧死的字幕之类，在任何缩放之前做
  const pre = clip.sourceCrop
    ? `crop=${clip.sourceCrop.w}:${clip.sourceCrop.h}:${clip.sourceCrop.x}:${clip.sourceCrop.y},`
    : ''

  switch (clip.fitMode) {
    case 'cover':
      return `[${inLabel}]${pre}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:(iw-ow)*${clip.cropOffsetX}:(ih-oh)*${clip.cropOffsetY}[${outLabel}]`

    case 'contain':
      return `[${inLabel}]${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[${outLabel}]`

    case 'blur': {
      // 先缩到小尺寸再模糊，然后放大。直接对 1080x1920 做大 sigma 的高斯模糊
      // 会慢得离谱，而模糊本身掩盖了放大的画质损失——观感完全一样。
      const bw = Math.round(W / 4), bh = Math.round(H / 4)
      return `[${inLabel}]${pre}split=2[fg_${outLabel}][bgsrc_${outLabel}];` +
        `[bgsrc_${outLabel}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,` +
        `crop=${bw}:${bh},gblur=sigma=8,scale=${W}:${H},` +
        `eq=brightness=-0.18:saturation=0.7[bg_${outLabel}];` +
        `[fg_${outLabel}]scale=${W}:-2[fgs_${outLabel}];` +
        `[bg_${outLabel}][fgs_${outLabel}]overlay=(W-w)/2:(H-h)/2[${outLabel}]`
    }
  }
}

/**
 * 构造音频滤镜。
 *
 * 输入约定：[1:a] 是配音，[2:a] 是 BGM（若有）。
 * 背景视频的原声【一律丢弃】——不 map 就是了。
 */
export function buildAudioFilter (hasBgm: boolean, bgmVolume: number): string {
  if (!hasBgm) return '[1:a]anull[aout]'

  // normalize=0：amix 默认会把所有输入按数量等比压低，配音会突然变小声。
  // duration=first：以配音为准，BGM 长了截断。
  return `[1:a]volume=1.0[voice];[2:a]volume=${bgmVolume}[bgmq];` +
    `[voice][bgmq]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/render/filters.test.ts`
Expected: 12 passed

- [ ] **Step 5: 提交**

```bash
git add src/render/filters.ts tests/render/filters.test.ts
git commit -m "feat: ffmpeg 滤镜链构造（纯函数）

blur 模式先缩小再模糊再放大——直接对 1080x1920 做大 sigma 模糊
慢得离谱，而模糊掩盖了放大的损失，观感一致。
amix 必须 normalize=0，否则配音会被压低。"
```

---

## Task 9: render/ffmpeg —— 执行与进度

**Files:**
- Create: `src/render/ffmpeg.ts`, `src/render/index.ts`
- Test: `tests/render/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `buildFitFilter`、`buildAudioFilter`、`RenderJob`、`FONTS_DIR`
- Produces: `parseProgress(chunk: string, totalMs: number): number | null`、`buildArgs(job: RenderJob): string[]`、`render(job: RenderJob, onProgress?: (pct: number) => void): Promise<void>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/render/ffmpeg.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { parseProgress, buildArgs } from '../../src/render/ffmpeg.js'
import { ASPECT_PRESETS } from '../../src/config.js'
import type { RenderJob } from '../../src/types.js'

const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  clips: [{ path: '/tmp/v.mp4', fitMode: 'cover', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
  voicePath: '/tmp/voice.mp3',
  bgmVolume: 0.1,
  assPath: '/tmp/s.ass',
  aspect: ASPECT_PRESETS['9:16']!,
  durationMs: 184200,
  outPath: '/tmp/out.mp4',
  ...over,
})

describe('parseProgress', () => {
  it('从 -progress 输出里解析百分比', () => {
    expect(parseProgress('out_time_ms=92100000', 184200)).toBeCloseTo(50, 0)
  })

  it('无关输出返回 null', () => {
    expect(parseProgress('frame=100\nfps=30', 184200)).toBeNull()
  })

  it('百分比夹在 0..100，不会超过 100', () => {
    expect(parseProgress('out_time_ms=999999000', 184200)).toBe(100)
  })
})

describe('buildArgs', () => {
  it('单片段用 -stream_loop -1 循环输入', () => {
    // 26.5 秒的视频要铺满 184 秒的配音
    expect(buildArgs(job())).toContain('-stream_loop')
  })

  it('输出时长等于配音时长——配音定生死', () => {
    const args = buildArgs(job())
    const i = args.indexOf('-t')
    expect(args[i + 1]).toBe('184.2')
  })

  it('必须 -pix_fmt yuv420p，否则部分播放器和平台不能播', () => {
    expect(buildArgs(job())).toContain('yuv420p')
  })

  it('烧 ASS 时带 fontsdir', () => {
    expect(buildArgs(job()).join(' ')).toContain('fontsdir=/usr/share/fonts/opentype/noto')
  })

  it('不 map 背景视频的音轨——原声一律丢弃', () => {
    const mapped = buildArgs(job()).filter((_, i, a) => a[i - 1] === '-map')
    expect(mapped).toEqual(['[v]', '[aout]'])
    expect(mapped).not.toContain('0:a')
  })

  it('有 BGM 时把它作为第三个输入', () => {
    const args = buildArgs(job({ bgmPath: '/tmp/bgm.mp3' }))
    expect(args).toContain('/tmp/bgm.mp3')
  })

  it('带 -progress pipe:1 才能拿到进度', () => {
    expect(buildArgs(job()).join(' ')).toContain('-progress pipe:1')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/render/ffmpeg.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/render/ffmpeg.ts`：

```typescript
import { spawn } from 'node:child_process'
import { FONTS_DIR } from '../config.js'
import { buildFitFilter, buildAudioFilter } from './filters.js'
import type { RenderJob } from '../types.js'

/**
 * 解析 ffmpeg -progress 的输出，返回 0..100 的百分比。
 * 拿不到进度信息时返回 null。
 */
export function parseProgress (chunk: string, totalMs: number): number | null {
  const m = /out_time_ms=(\d+)/.exec(chunk)
  if (!m) return null
  const doneMs = Number(m[1]) / 1000   // out_time_ms 实际单位是微秒
  return Math.min(100, Math.max(0, (doneMs / totalMs) * 100))
}

/**
 * 构造 ffmpeg 参数。
 *
 * 输入顺序（滤镜里靠这个索引）：0=背景视频，1=配音，2=BGM（若有）。
 *
 * ⚠️ 本函数只处理【单片段】的快路径——用 -stream_loop -1 直接循环输入。
 * 多片段需要两趟渲染（ffmpeg 的 loop 滤镜按帧工作、吃内存，而 -stream_loop
 * 只能作用于输入文件，没法作用于 concat 的结果）。多片段留到阶段 3 前实现，
 * 届时先把片段拼接成中间文件，再走这条同样的路径。
 */
export function buildArgs (job: RenderJob): string[] {
  const clip = job.clips[0]
  if (!clip) throw new Error('至少需要一个背景视频片段')
  if (job.clips.length > 1) {
    throw new Error('多片段拼接尚未实现——需要两趟渲染，见 render/ffmpeg.ts 的说明')
  }

  const durationSec = (job.durationMs / 1000).toFixed(1)
  const hasBgm = Boolean(job.bgmPath)

  const filters = [
    buildFitFilter(clip, job.aspect, '0:v', 'fit'),
    `[fit]ass=${job.assPath}:fontsdir=${FONTS_DIR}[v]`,
    buildAudioFilter(hasBgm, job.bgmVolume),
  ].join(';')

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-progress', 'pipe:1',
    '-stream_loop', '-1', '-i', clip.path,
    '-i', job.voicePath,
    ...(hasBgm ? ['-i', job.bgmPath!] : []),
    '-filter_complex', filters,
    '-map', '[v]', '-map', '[aout]',
    '-t', durationSec,
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-pix_fmt', 'yuv420p',        // 不加这条，成片在部分播放器和平台上直接不能播
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    job.outPath,
  ]
}

/** 跑 ffmpeg。失败时把 stderr 完整带出来——否则排查等于瞎猜。 */
export function render (job: RenderJob, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', buildArgs(job))
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => {
      const pct = parseProgress(d.toString(), job.durationMs)
      if (pct !== null) onProgress?.(pct)
    })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) { onProgress?.(100); resolve() }
      else reject(new Error(`ffmpeg 退出码 ${code}：\n${stderr.slice(-2000)}`))
    })
  })
}
```

创建 `src/render/index.ts`：

```typescript
export { render, buildArgs, parseProgress } from './ffmpeg.js'
export { buildFitFilter, buildAudioFilter } from './filters.js'
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/render/ffmpeg.test.ts`
Expected: 10 passed

- [ ] **Step 5: 提交**

```bash
git add src/render/ffmpeg.ts src/render/index.ts tests/render/ffmpeg.test.ts
git commit -m "feat: ffmpeg 执行与进度解析

单片段走 -stream_loop 快路径。多片段需要两趟渲染（loop 滤镜吃内存，
-stream_loop 只能作用于输入文件），暂时显式拒绝而非悄悄出错。"
```

---

## Task 10: tts —— Azure 封装

**Files:**
- Create: `src/tts/azure.ts`, `src/tts/index.ts`
- Test: `tests/tts/azure.test.ts`

**Interfaces:**
- Consumes: `unescapeXml`、`WordTiming`、`TtsResult`
- Produces: `estimateAudioMs(text: string): number`、`toWordTiming(e: {text,audioOffset,duration,boundaryType}): WordTiming`、`synthesize(opts): Promise<TtsResult>`

- [ ] **Step 1: 写失败的测试**

只测纯函数部分——真实合成会烧配额且需要网络，放到 Task 11 的端到端里跑一次。

创建 `tests/tts/azure.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { estimateAudioMs, toWordTiming } from '../../src/tts/azure.js'

describe('toWordTiming', () => {
  it('audioOffset 是 100 纳秒单位，除以 10000 得毫秒', () => {
    const r = toWordTiming({ text: '震惊', audioOffset: 5000000, duration: 5880000, boundaryType: 'WordBoundary' })
    expect(r.offsetMs).toBe(500)
    expect(r.durationMs).toBe(588)
  })

  it('反转义 XML 实体——Azure 返回的是转义后的形态', () => {
    const r = toWordTiming({ text: '&amp;', audioOffset: 0, duration: 0, boundaryType: 'WordBoundary' })
    expect(r.text).toBe('&')
  })

  it('识别标点事件', () => {
    const r = toWordTiming({ text: '！', audioOffset: 0, duration: 0, boundaryType: 'PunctuationBoundary' })
    expect(r.isPunctuation).toBe(true)
  })

  it('词事件不是标点', () => {
    const r = toWordTiming({ text: '包子', audioOffset: 0, duration: 0, boundaryType: 'WordBoundary' })
    expect(r.isPunctuation).toBe(false)
  })
})

describe('estimateAudioMs', () => {
  it('估算用于提交前拦截超长文案', () => {
    // 实测：937 字 → 184.2 秒，约 196ms/字
    expect(estimateAudioMs(937)).toBeGreaterThan(150000)
    expect(estimateAudioMs(937)).toBeLessThan(220000)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/tts/azure.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/tts/azure.ts`：

```typescript
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { unescapeXml } from '../importers/sanitize.js'
import type { WordTiming, TtsResult } from '../types.js'

/** F0 免费层单次请求的音频上限是 10 分钟 */
const MAX_AUDIO_MS = 10 * 60 * 1000

/** 实测：937 字 → 184.2 秒，约 196 ms/字。用于提交前拦截，不求精确。 */
export function estimateAudioMs (charCount: number): number {
  return charCount * 196
}

/**
 * 把 Azure 的 WordBoundary 事件归一化成我们的结构。
 *
 * 两个坑（都已实测）：
 *   1. audioOffset 单位是 100 纳秒（HNS），除以 10000 才是毫秒
 *   2. text 是【XML 转义后】的形态——& 回来是 &amp;，必须反转义，
 *      否则字幕会字面显示实体码
 *
 * 【不要用 textOffset】：它指向 SSML 字符串位置而非原文，
 * 转义会让偏移错位。只用 text。
 */
export function toWordTiming (e: {
  text: string; audioOffset: number; duration: number; boundaryType: string
}): WordTiming {
  return {
    text: unescapeXml(e.text),
    offsetMs: e.audioOffset / 10000,
    durationMs: e.duration / 10000,
    isPunctuation: e.boundaryType.toLowerCase().includes('punct'),
  }
}

export interface SynthesizeOptions {
  text: string
  outPath: string
  voice?: string
  rate?: number
  key: string
  region: string
}

/**
 * 整篇一次合成，绝不逐句请求。
 *
 * F0 限速是【每 60 秒 20 次请求】——一篇 30 句的文案逐句合成
 * 就是 30 次请求，直接撞墙。单次最长可出 10 分钟音频，够用。
 *
 * 这是可替换接口：换 TTS 服务商只动这个模块。
 */
export function synthesize (opts: SynthesizeOptions): Promise<TtsResult> {
  const est = estimateAudioMs(opts.text.length)
  if (est > MAX_AUDIO_MS) {
    throw new Error(
      `文案太长（约 ${Math.round(est / 60000)} 分钟音频），` +
      `超过免费层单次 10 分钟的上限。请拆成多个项目。`
    )
  }

  return new Promise((resolve, reject) => {
    const config = sdk.SpeechConfig.fromSubscription(opts.key, opts.region)
    config.speechSynthesisVoiceName = opts.voice ?? 'zh-CN-XiaoxiaoNeural'
    config.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3

    const synth = new sdk.SpeechSynthesizer(
      config, sdk.AudioConfig.fromAudioFileOutput(opts.outPath))

    const words: WordTiming[] = []
    synth.wordBoundary = (_s, e) => {
      words.push(toWordTiming({
        text: e.text, audioOffset: e.audioOffset,
        duration: e.duration, boundaryType: String(e.boundaryType),
      }))
    }

    synth.speakTextAsync(opts.text, (result) => {
      synth.close()
      if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
        // 配额耗尽和限流都会走到这里，把原始信息带出去让上层能区分
        reject(new Error(`配音失败：${result.errorDetails}`))
        return
      }
      resolve({
        audioPath: opts.outPath,
        durationMs: result.audioDuration / 10000,
        words,
      })
    }, (err) => { synth.close(); reject(new Error(`配音出错：${err}`)) })
  })
}
```

创建 `src/tts/index.ts`：

```typescript
export { synthesize, toWordTiming, estimateAudioMs } from './azure.js'
export type { SynthesizeOptions } from './azure.js'
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/tts/azure.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/tts/ tests/tts/azure.test.ts
git commit -m "feat: Azure TTS 封装——可替换接口

整篇一次合成：F0 限速 20 次/60 秒，逐句请求会直接撞墙。
audioOffset 是 HNS 单位除以 10000；text 要反转义；不用 textOffset。"
```

---

## Task 11: cli —— 端到端

把五个模块串起来，重现阶段 0 那条 demo——但这次是正经代码。

**Files:**
- Create: `src/cli.ts`, `.env.example`
- Modify: `package.json`（scripts）

**Interfaces:**
- Consumes: 前面所有模块

- [ ] **Step 1: 写 CLI**

创建 `src/cli.ts`：

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { assertFontAvailable, ASPECT_PRESETS } from './config.js'
import { importScript } from './importers/index.js'
import { synthesize } from './tts/index.js'
import { segmentLines, buildAss } from './subtitles/index.js'
import { render } from './render/index.js'
import type { TextOverlay } from './types.js'

loadEnv()

const { values } = parseArgs({
  options: {
    script: { type: 'string' },
    video: { type: 'string' },
    bgm: { type: 'string' },
    out: { type: 'string' },
    title: { type: 'string' },
    aspect: { type: 'string', default: '9:16' },
    mode: { type: 'string', default: 'karaoke' },
  },
})

if (!values.script || !values.video || !values.out) {
  console.error(`用法：npm run cli -- --script <文案> --video <背景视频> --out <成片.mp4>
  可选：--bgm <音乐> --title <标题> --aspect 9:16|4:5|1:1|16:9 --mode karaoke|line`)
  process.exit(1)
}

const key = process.env.AZURE_SPEECH_KEY
const region = process.env.AZURE_SPEECH_REGION
if (!key || !region) {
  console.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，参考 .env.example')
  process.exit(1)
}

const aspect = ASPECT_PRESETS[values.aspect!]
if (!aspect) {
  console.error(`未知画幅：${values.aspect}。支持 ${Object.keys(ASPECT_PRESETS).join(' / ')}`)
  process.exit(1)
}

// 字体是静默失败的——必须主动探测，不能等到成片出来才发现字幕是方块
assertFontAvailable()

console.log('→ 读文案')
const text = await importScript(values.script)
console.log(`  ${text.length} 字`)

console.log('→ 配音（整篇一次合成）')
const tts = await synthesize({ text, outPath: '/tmp/sj-voice.mp3', key, region })
console.log(`  ${(tts.durationMs / 1000).toFixed(1)} 秒，${tts.words.length} 个词级事件`)

console.log('→ 断句并生成 ASS')
const lines = segmentLines(tts.words, 14)
const overlays: TextOverlay[] = [
  { content: '小说内容纯属虚构，无不良引导', style: 'Disclaimer', startMs: null, endMs: null },
]
if (values.title) {
  overlays.push({ content: values.title, style: 'Title', startMs: null, endMs: null })
}
const ass = buildAss({
  lines, overlays, aspect, durationMs: tts.durationMs,
  mode: values.mode === 'line' ? 'line' : 'karaoke',
})
writeFileSync('/tmp/sj-sub.ass', ass)
console.log(`  ${lines.length} 行字幕`)

console.log('→ 合成')
await render({
  clips: [{ path: values.video, fitMode: 'blur', cropOffsetX: 0.5, cropOffsetY: 0.5 }],
  voicePath: tts.audioPath,
  bgmPath: values.bgm,
  bgmVolume: 0.1,
  assPath: '/tmp/sj-sub.ass',
  aspect,
  durationMs: tts.durationMs,
  outPath: values.out,
}, (pct) => process.stdout.write(`\r  ${pct.toFixed(0)}%`))

console.log(`\n✅ ${values.out}`)
```

创建 `.env.example`：

```
AZURE_SPEECH_KEY=Azure 门户 → Speech 资源 → Resource Management → Keys and Endpoint → KEY 1
AZURE_SPEECH_REGION=eastus
```

- [ ] **Step 2: 装 dotenv 并配好 .env**

```bash
npm install dotenv
cp .env.example .env
# 把真实的 key 和 region 填进 .env（.env 已被 .gitignore 排除）
```

- [ ] **Step 3: 端到端跑一次，重现阶段 0 的 demo**

```bash
npm run cli -- \
  --script Example/test.txt \
  --video "Example/QQ录屏20240929185220.mp4" \
  --title 包子 \
  --out /tmp/e2e.mp4
```

Expected:
```
→ 读文案
  937 字
→ 配音（整篇一次合成）
  184.2 秒，661 个词级事件
→ 断句并生成 ASS
  109 行字幕
→ 合成
  100%
✅ /tmp/e2e.mp4
```

**判据**：字数、音频时长、事件数、字幕行数应与阶段 0 的 demo 一致（±少量，TTS 每次合成有细微差异）。这证明重构没有改变行为。

- [ ] **Step 4: 验证成片**

```bash
ffprobe -hide_banner -loglevel error \
  -show_entries stream=codec_name,width,height -show_entries format=duration \
  -of default=nw=1 /tmp/e2e.mp4
ffmpeg -hide_banner -loglevel error -y -ss 30 -i /tmp/e2e.mp4 -vframes 1 /tmp/e2e.png
```

Expected: `width=1080`、`height=1920`、`codec_name=h264`、`duration≈184`。
**并且亲眼看 `/tmp/e2e.png`**：标题在顶、免责声明在底、中间有黄白扫光的字幕、中文不是方块。

- [ ] **Step 5: 跑全部测试**

Run: `npm test`
Expected: 全部通过（约 60 个）

- [ ] **Step 6: 提交**

```bash
git add src/cli.ts .env.example package.json package-lock.json
git commit -m "feat: 端到端 CLI——五个模块串起来

重现了阶段 0 的手搓 demo，但这次是有边界、有测试的正经代码。
字数/时长/事件数/行数与 demo 一致，证明重构没改变行为。"
```

---

## Task 12: 阶段收尾

- [ ] **Step 1: 跑全部测试并确认无跳过**

Run: `npm test`
Expected: 全部通过，0 skipped

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 更新设计文档的实现状态**

在 `docs/superpowers/specs/2026-07-16-surejack-design.md` 第 12 节的模块列表里，给已实现的模块标注状态，并注明多片段拼接尚未实现（`render/ffmpeg.ts` 目前显式拒绝多片段，需要两趟渲染）。

- [ ] **Step 4: 提交并汇报**

```bash
git add -A
git commit -m "docs: 标注阶段 1 的实现状态"
```

向用户汇报：**能跑什么、不能跑什么、测试覆盖了什么**。明确说明本阶段**没有** HTTP、数据库、界面——那是阶段 2 和 3。
