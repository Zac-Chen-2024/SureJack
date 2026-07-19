# 长文案自动分段合成 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 超过单次 10 分钟上限的文案，后台自动切段、分别合成、拼接成一条音频和一条连续时间轴，用户无需手工拆项目。

**Architecture:** 在现有 `synthesize()` 之上加一层 `synthesizeLong()`。切段只在句末标点处发生；每段独立合成得到「音频 + 相对本段的词时间轴」；用 **ffprobe 量出的真实时长** 累加成偏移量，平移后段的时间戳；音频用 ffmpeg concat 拼接。下游字幕/渲染管线**零改动**——它们拿到的仍是「一条音频 + 一条 WordTiming[]」。

**Tech Stack:** TypeScript / Node / microsoft-cognitiveservices-speech-sdk / ffmpeg / vitest

## Global Constraints

- Azure **单次请求上限 10 分钟音频**，F0 与 S0 相同——这不是免费层限制，付费也要拆。
- Azure F0 限速 **每 60 秒 20 次请求**。切段后仍必须远低于此。
- 月配额 500k 字符：**切段不增加字符消耗**，总字数不变。
- 词时间戳偏移量**必须**来自 `probeDurationMs()` 实测，**禁止**使用 `estimateAudioMs()` 或「最后一个词的 offsetMs + durationMs」。
- 现有 `WordTiming` 结构不得更改（`subtitles/` 和 `render/` 都依赖它）。
- **测试框架是 vitest**（`describe`/`it`/`expect`），不是 `node:test`。仓库的 `npm test` 就是 `vitest run`，且 `vitest.config.ts` 的 include 是 `tests/**/*.test.ts`——用 `node:test` 写的文件会被扫进来并报 「No test suite found」，让整个套件变红。
- **每个 `expect(...)` 后面必须接 matcher**（`.toBe` / `.toEqual` / `.toThrow` …）。光写 `expect(布尔表达式)` 什么都不断言，测试会假绿。
- 中文注释，与现有代码风格一致。

---

## 为什么偏移量必须实测（实现者必读）

段 2 的所有词时间戳都要加上「段 1 的时长」。这个时长有三种取法，**只有一种是对的**：

| 取法 | 为什么错 |
|---|---|
| `estimateAudioMs(段1字数)` | 估算系数 196ms/字 本身就有 ±5% 波动，一段就能差几秒 |
| 最后一个词的 `offsetMs + durationMs` | **最常见的错法**。最后一个词念完之后还有尾音和静音，音频文件比这个值长。差值通常 100–400ms |
| `await probeDurationMs(段1音频路径)` | ✅ 正确。这是文件的真实时长，拼接后段 2 就是从这一刻开始的 |

**误差是累积的**：段 1 少算 200ms，段 2 整体偏 200ms，段 3 偏 400ms……症状是「前面字幕对得很准，越到后面越飘」。这种 bug 在短文案测试里完全看不出来，必须靠 Task 3 的测试卡住。

---

## 文件结构

- `src/tts/split.ts` — **新建**。纯函数：把文案切成若干段。无 IO，好测。
- `src/tts/concat.ts` — **新建**。ffmpeg 拼接音频。有 IO。
- `src/tts/long.ts` — **新建**。编排：切段 → 逐段合成 → 平移时间轴 → 拼接。
- `src/tts/azure.ts` — **修改**。移除 `synthesize()` 内的长度拒绝（改由 `long.ts` 负责决定切不切）。
- `src/tts/routes.ts` — **修改**。改调 `synthesizeLong()`，返回 `segmentCount`。
- `src/tts/index.ts` — **修改**。导出新函数。
- `tests/tts/split.test.ts`、`tests/tts/long.test.ts`、`tests/tts/concat.test.ts` — 新建。

---

### Task 1: 切段纯函数

**Files:**
- Create: `src/tts/split.ts`
- Test: `tests/tts/split.test.ts`

**Interfaces:**
- Consumes: `estimateAudioMs(charCount: number): number` from `./azure.js`
- Produces: `splitScript(text: string, maxMsPerChunk?: number): string[]`

**设计要点：**
- 只在**句末标点**后切：`。！？；…` 以及换行。逗号不算——在逗号处切，语气断裂明显。
- 目标每段 ≤ **8 分钟**（`DEFAULT_MAX_MS = 8 * 60 * 1000`），不是 10 分钟。留 2 分钟余量给估算误差。
- 短文案（估算 ≤ 8 分钟）返回 `[text]` 单元素数组——**不走拼接路径**，行为与现在完全一致。
- 兜底：单句就超上限时硬切，不能死循环。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { splitScript } from '../../src/tts/split.js'
import { estimateAudioMs, maxCharsForMs } from '../../src/tts/azure.js'

const MAX_MS = 8 * 60 * 1000

const sentence = '他决定去买包子。'          // 8 字
const long = sentence.repeat(400)            // 3200 字，约 10.5 分钟

describe('splitScript', () => {
  it('短文案不切，原样单段返回', () => {
    expect(splitScript('他决定去买包子。')).toEqual(['他决定去买包子。'])
  })

  it('长文案切成多段', () => {
    expect(splitScript(long).length).toBeGreaterThanOrEqual(2)
  })

  it('切段不丢字、不重复——拼回去等于原文', () => {
    expect(splitScript(long).join('')).toBe(long)
  })

  it('每段都在预算内', () => {
    for (const c of splitScript(long)) {
      expect(estimateAudioMs(c.length)).toBeLessThanOrEqual(MAX_MS)
    }
  })

  it('只在句末标点后切，不在句子中间断开', () => {
    for (const c of splitScript(long)) {
      expect(c).toMatch(/[。！？；…\n]$/)
    }
  })

  it('单句超上限时硬切，不死循环', () => {
    const noPunct = '包'.repeat(5000)   // 完全没有标点，约 16 分钟
    const chunks = splitScript(noPunct)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('')).toBe(noPunct)
  })

  it('自定义 maxMs 生效——预算减半，段数应增加', () => {
    expect(splitScript(long, MAX_MS / 2).length)
      .toBeGreaterThan(splitScript(long, MAX_MS).length)
  })

  it('空文案不崩溃', () => {
    expect(splitScript('')).toEqual([''])
  })

  /*
   * 边界：恰好卡在预算线上。这同时检验 estimateAudioMs 与 maxCharsForMs
   * 是否真的互为反函数——两处若各自抄了一份 196，这条会红。
   */
  it('恰好等于预算的文案不切', () => {
    const exact = '包'.repeat(maxCharsForMs(MAX_MS))
    expect(splitScript(exact, MAX_MS)).toEqual([exact])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tts/split.test.ts`
Expected: FAIL — `Cannot find module '../../src/tts/split.js'`

- [ ] **Step 3: 实现**

```typescript
import { estimateAudioMs, maxCharsForMs } from './azure.js'

/**
 * 每段的目标上限。Azure 单次硬上限是 10 分钟，这里取 8 分钟：
 * estimateAudioMs 有 ±5% 波动，留 2 分钟余量避免估算偏低时打到 Azure 才失败。
 */
const DEFAULT_MAX_MS = 8 * 60 * 1000

/** 句末标点。逗号【不在】此列——在逗号处切，接缝的语气断裂会很明显。 */
const SENTENCE_END = /[。！？；…\n]/

/**
 * 把文案切成若干段，每段估算时长不超过 maxMs。
 *
 * 只在句末标点【之后】切。切点选在自然停顿处，独立合成时
 * 段与段之间的语气变化才会被听成「一次停顿」而非「一处断裂」。
 *
 * 短文案原样返回单元素数组——调用方据此跳过拼接路径，
 * 行为与未引入分段前完全一致。
 */
export function splitScript (text: string, maxMs = DEFAULT_MAX_MS): string[] {
  if (estimateAudioMs(text.length) <= maxMs) return [text]

  // 先按句末标点切成句子，标点跟在句子末尾
  const sentences: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (SENTENCE_END.test(ch)) { sentences.push(cur); cur = '' }
  }
  if (cur) sentences.push(cur)   // 结尾没标点的残句

  // 走 azure.ts 导出的反函数，不在这里另抄一份 196——否则调系数时会静默漂移
  const maxChars = maxCharsForMs(maxMs)
  const chunks: string[] = []
  let buf = ''

  for (const s of sentences) {
    // 单句本身就超预算：先冲掉缓冲，再把这句硬切。
    // 没有这一步会死循环——它永远塞不进任何缓冲区。
    if (s.length > maxChars) {
      if (buf) { chunks.push(buf); buf = '' }
      for (let i = 0; i < s.length; i += maxChars) {
        chunks.push(s.slice(i, i + maxChars))
      }
      continue
    }
    // 先判断再累加。反过来「先加后判」会放出超预算的段。
    if (buf.length + s.length > maxChars) { chunks.push(buf); buf = '' }
    buf += s
  }
  if (buf) chunks.push(buf)

  return chunks
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tts/split.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tts/split.ts tests/tts/split.test.ts
git commit -m "feat(tts): 文案按句末标点切段的纯函数"
```

---

### Task 2: 音频拼接

**Files:**
- Create: `src/tts/concat.ts`
- Test: `tests/tts/concat.test.ts`

**Interfaces:**
- Consumes: `probeDurationMs(path: string): Promise<number>` from `../render/probe.js`
- Produces: `concatAudio(inputs: string[], outPath: string): Promise<void>`

**设计要点：** 用 ffmpeg 的 **concat demuxer**（`-f concat`）并**重新编码**（`-c:a libmp3lame`）。不用 `-c copy`：各段是独立编码的 mp3，直接拷贝拼接会在接缝处留下编码器 padding，产生可听见的咔哒声。重编码一次的代价（几秒）远小于成片里的杂音。

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { concatAudio } from '../../src/tts/concat.js'
import { probeDurationMs } from '../../src/render/probe.js'

const run = promisify(execFile)

/** 用 ffmpeg 生成一段指定秒数的静音 mp3 */
async function silence (path: string, seconds: number) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    `anullsrc=r=24000:cl=mono`, '-t', String(seconds), path])
}

describe('concatAudio', () => {
  it('拼接后的时长约等于各段之和', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat-'))
    try {
      const a = join(dir, 'a.mp3'), b = join(dir, 'b.mp3'), out = join(dir, 'out.mp3')
      await silence(a, 2); await silence(b, 3)

      await concatAudio([a, b], out)

      // 容差 300ms：mp3 帧对齐会有零头
      expect(await probeDurationMs(out)).toBeGreaterThan(4700)
      expect(await probeDurationMs(out)).toBeLessThan(5300)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('单段输入也能正常处理', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concat1-'))
    try {
      const a = join(dir, 'a.mp3'), out = join(dir, 'out.mp3')
      await silence(a, 2)
      await concatAudio([a], out)
      expect(await probeDurationMs(out)).toBeGreaterThan(1700)
      expect(await probeDurationMs(out)).toBeLessThan(2300)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  /*
   * 这不是假想的边界：用户素材里真实存在 剪素材n'n.mp4。
   * concat 清单用单引号包路径，不转义就会被解析错。
   */
  it('路径含单引号时不被 concat 清单语法破坏', async () => {
    const dir = await mkdtemp(join(tmpdir(), "con'cat-"))
    try {
      const a = join(dir, "a'1.mp3"), out = join(dir, 'out.mp3')
      await silence(a, 1)
      await concatAudio([a], out)
      expect(await probeDurationMs(out)).toBeGreaterThan(500)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('输入为空时抛出可读的错误', async () => {
    await expect(concatAudio([], '/tmp/x.mp3')).rejects.toThrow(/输入为空/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tts/concat.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```typescript
import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'

/**
 * 用 ffmpeg concat demuxer 拼接多段音频。
 *
 * 【重新编码，不用 -c copy】：各段是独立编码的 mp3，每段开头结尾都带
 * 编码器 padding。直接拷贝拼接会把这些 padding 留在接缝处，产生
 * 可听见的咔哒声。重编码一次只花几秒，远比成片里的杂音便宜。
 */
export async function concatAudio (inputs: string[], outPath: string): Promise<void> {
  if (inputs.length === 0) throw new Error('concatAudio: 输入为空')

  // concat 清单的转义规则：单引号要写成 '\'' 的形式。
  // 不转义的话，路径里一个单引号就能让 ffmpeg 把清单读错。
  const listPath = `${outPath}.concat.txt`
  const list = inputs
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n')
  await writeFile(listPath, list, 'utf8')

  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',          // 允许绝对路径
        '-i', listPath,
        '-c:a', 'libmp3lame',
        '-b:a', '96k',         // 与 synthesize 的输出码率一致
        outPath,
      ])
      let stderr = ''
      ff.stderr.on('data', (d) => { stderr += String(d) })
      ff.on('error', reject)
      ff.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`音频拼接失败（ffmpeg ${code}）：${stderr.slice(-500)}`))
      })
    })
  } finally {
    await unlink(listPath).catch(() => {})   // 清单是中间产物，失败也要清掉
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tts/concat.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tts/concat.ts tests/tts/concat.test.ts
git commit -m "feat(tts): ffmpeg 音频拼接，重编码避免接缝咔哒声"
```

---

### Task 3: 时间轴平移（本计划最关键的一步）

**Files:**
- Create: `src/tts/long.ts`（先只写平移函数）
- Test: `tests/tts/long.test.ts`

**Interfaces:**
- Consumes: `WordTiming` from `../types.js`
- Produces: `shiftWords(words: WordTiming[], offsetMs: number): WordTiming[]`

- [ ] **Step 1: 写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { shiftWords } from '../../src/tts/long.js'
import type { WordTiming } from '../../src/types.js'

const w = (text: string, offsetMs: number, durationMs = 300): WordTiming =>
  ({ text, offsetMs, durationMs, isPunctuation: false })

describe('shiftWords', () => {
  it('平移只改 offsetMs，不改 durationMs', () => {
    const out = shiftWords([w('他', 0, 250), w('决定', 300, 400)], 5000)
    expect(out.map((x) => x.offsetMs)).toEqual([5000, 5300])
    expect(out.map((x) => x.durationMs)).toEqual([250, 400])
  })

  it('偏移 0 时原样返回', () => {
    expect(shiftWords([w('他', 120)], 0)).toEqual([w('他', 120)])
  })

  /*
   * 返回新数组：调用方可能还要用原始的段内时间轴排查问题。
   *
   * 【注意断言写法】tsconfig 开了 noUncheckedIndexedAccess，`arr[0]` 的
   * 类型是 T | undefined，直接 `.offsetMs` 取值过不了 tsc。整体比对数组
   * 既避开这个问题，又顺带断言了「其他字段没被动过」。不要用 `!` 绕过。
   */
  it('不修改入参数组', () => {
    const orig = [w('他', 100)]
    shiftWords(orig, 5000)
    expect(orig).toEqual([w('他', 100)])
  })

  it('文字与标点标记原样保留', () => {
    const src: WordTiming[] = [{ text: '。', offsetMs: 0, durationMs: 100, isPunctuation: true }]
    expect(shiftWords(src, 1000)).toEqual([
      { text: '。', offsetMs: 1000, durationMs: 100, isPunctuation: true },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tts/long.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```typescript
import type { WordTiming } from '../types.js'

/**
 * 把一段的词时间轴整体平移 offsetMs。
 *
 * 【只动 offsetMs】：durationMs 是这个词自身念了多久，与它在总时间轴上
 * 的位置无关，平移时绝不能动。
 *
 * 返回新数组，不就地修改——调用方可能还要用原始的段内时间轴排查问题。
 */
export function shiftWords (words: WordTiming[], offsetMs: number): WordTiming[] {
  return words.map((w) => ({ ...w, offsetMs: w.offsetMs + offsetMs }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tts/long.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tts/long.ts tests/tts/long.test.ts
git commit -m "feat(tts): 词时间轴平移"
```

---

### Task 4: 编排 synthesizeLong

**Files:**
- Modify: `src/tts/long.ts`
- Modify: `src/tts/azure.ts:68-75`（移除长度拒绝）
- Test: `tests/tts/long.test.ts`（追加）

**Interfaces:**
- Consumes: `splitScript`、`concatAudio`、`shiftWords`、`probeDurationMs`、`SynthesizeOptions`、`TtsResult`
- Produces:
  ```typescript
  export interface LongTtsResult extends TtsResult { segmentCount: number }
  export function synthesizeLong (
    opts: SynthesizeOptions,
    deps?: { synthesize?: typeof synthesize; probe?: typeof probeDurationMs }
  ): Promise<LongTtsResult>
  ```

**`deps` 参数是为了测试**——注入假的 synthesize，就能在不打 Azure、不花配额的前提下测完整的分段+平移逻辑。生产调用不传它。

**⚠️ 但 `concatAudio` 不可注入**（有意如此：多段路径要真跑一次 ffmpeg 才算测到）。
所以假的 synthesize **必须产出真正可解码的音频**，不能只 `writeFile(outPath, 'x')`——
那样多段路径会让 ffmpeg 去拼几个内容是字母 x 的文件，必然失败。用 ffmpeg 现生成
一秒静音即可：

```typescript
const silence = async (path: string) => {
  await promisify(execFile)('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'anullsrc=r=24000:cl=mono', '-t', '1', path])
}
```

测试里的输出路径请用 `mkdtemp` 临时目录，不要写死 `/tmp/lt-out.mp3`——
写死的话，上一次运行的残留会污染「中间文件不残留」那条断言。

**azure.ts 的改动**：删掉 `synthesize()` 里 `if (est * REJECTION_SAFETY_MARGIN > MAX_AUDIO_MS) throw` 这段。切不切现在由 `splitScript` 决定，`synthesize` 只管合成拿到的这一段。**`REJECTION_SAFETY_MARGIN` 和 `MAX_AUDIO_MS` 两个常量都要删**（都不再有使用者）。保留 `estimateAudioMs` / `MS_PER_CHAR` / `maxCharsForMs`——`splitScript` 在用。

**⚠️ 这一步还会波及一个既有测试，计划原先漏了：** `tests/tts/azure.test.ts` 里的
`synthesize 的拦截阈值` 用例必须一并删除。它传的是 `key: 'fake-key'`，而它自己的注释
写着「拦截发生在 new Promise 之前的 throw，不会真的发起网络请求，所以可以放心传假的
key/region」——**它用假密钥的安全性完全建立在那道拦截会先抛错上**。拦截一删，
`synthesize()` 就会继续往下建连接，这个用例会挂到 5 分钟超时才失败。
删除时留一行注释说明覆盖已转移到 `splitScript` 的预算测试。

- [ ] **Step 1: 写失败的测试（追加到 tests/tts/long.test.ts）**

```typescript
import { synthesizeLong } from '../../src/tts/long.js'
import { writeFile } from 'node:fs/promises'

it('长文案：偏移量用实测时长，且累积正确', async () => {
  const calls: string[] = []
  // 假 synthesize：每段都产出「段内从 0 开始」的时间轴
  const fakeSynth = async (o: any) => {
    calls.push(o.text)
    await writeFile(o.outPath, 'x')
    return {
      audioPath: o.outPath,
      words: [
        { text: '首', offsetMs: 0,    durationMs: 200, isPunctuation: false },
        { text: '末', offsetMs: 1000, durationMs: 200, isPunctuation: false },
      ],
      durationMs: 1200,
    }
  }
  // 假 probe：每段【真实】时长 5000ms —— 注意它比「末词结束时间 1200ms」大得多，
  // 正是尾音静音。用错取法的实现会在这里露馅。
  const fakeProbe = async () => 5000

  const long = '他决定去买包子。'.repeat(400)
  const r = await synthesizeLong(
    { text: long, outPath: '/tmp/lt-out.mp3', key: 'k', region: 'r' },
    { synthesize: fakeSynth as any, probe: fakeProbe as any }
  )

  expect(r.segmentCount).toBeGreaterThanOrEqual(2)
  expect(calls.length).toBe(r.segmentCount)          // 每段各合成一次

  const offsets = r.words.map((w) => w.offsetMs)

  // 段 1 的词不平移
  expect(offsets.slice(0, 2)).toEqual([0, 1000])

  /*
   * 【这条是整个计划的核心断言】
   * 段 2 的词整体 +5000（probe 量出的实测时长），而不是 +1200（末词结束时间）。
   * 若这里得到 [1200, 2200]，说明实现用了「最后一个词的 offsetMs + durationMs」，
   * 漏掉了尾音静音——而这个误差会逐段累积，成片越到后面字幕偏得越离谱。
   */
  expect(offsets.slice(2, 4)).toEqual([5000, 6000])

  // 时间轴必须单调不减——这是字幕分行的前提
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1])
  }
})

it('三段以上时误差不累积', async () => {
  // 每段实测 5000ms，第 3 段的偏移必须是 10000 而非 2×1200
  const fakeSynth = async (o: any) => {
    await writeFile(o.outPath, 'x')
    return { audioPath: o.outPath, durationMs: 1200,
      words: [{ text: '首', offsetMs: 0, durationMs: 200, isPunctuation: false }] }
  }
  const r = await synthesizeLong(
    { text: '他决定去买包子。'.repeat(900), outPath: '/tmp/lt3.mp3', key: 'k', region: 'r' },
    { synthesize: fakeSynth as any, probe: (async () => 5000) as any }
  )
  expect(r.segmentCount).toBeGreaterThanOrEqual(3)
  expect(r.words.map((w) => w.offsetMs).slice(0, 3)).toEqual([0, 5000, 10000])
})

it('短文案：单段直通，不触发拼接', async () => {
  const fakeSynth = async (o: any) => {
    await writeFile(o.outPath, 'x')
    return { audioPath: o.outPath, words: [
      { text: '他', offsetMs: 0, durationMs: 200, isPunctuation: false }], durationMs: 200 }
  }
  const r = await synthesizeLong(
    { text: '他决定去买包子。', outPath: '/tmp/st-out.mp3', key: 'k', region: 'r' },
    { synthesize: fakeSynth as any, probe: (async () => 200) as any }
  )
  expect(r.segmentCount).toBe(1)
  expect(r.words.map((x) => x.offsetMs)).toEqual([0])   // 不用 r.words[0]，见 Task 3 的说明
})

it('分段文件用完即清，不留残渣', async () => {
  // …跑完后确认目录下没有 *.partN.mp3…
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tts/long.test.ts`
Expected: FAIL — `synthesizeLong is not a function`

- [ ] **Step 3: 实现（追加到 src/tts/long.ts）**

```typescript
import { join, dirname, basename } from 'node:path'
import { unlink } from 'node:fs/promises'
import { synthesize, type SynthesizeOptions } from './azure.js'
import { splitScript } from './split.js'
import { concatAudio } from './concat.js'
import { probeDurationMs } from '../render/probe.js'
import type { TtsResult } from '../types.js'

export interface LongTtsResult extends TtsResult {
  /** 实际分了几段。1 表示没有分段，走的是直通路径。 */
  segmentCount: number
}

/**
 * 段间额外停顿，当前为 0——Azure 每段结尾自带的尾音已经足够像一次换气。
 *
 * 【若改成非零值，必须同时改两处】：这里的时间轴偏移，以及 concatAudio
 * 拼接时真的插入等长静音。只改一处会让之后每一句字幕都整体错位。
 */
const SEGMENT_GAP_MS = 0

/**
 * 长文案合成：自动切段 → 逐段合成 → 平移时间轴 → 拼接成一条音频。
 *
 * 短文案（不需要切）会直通到 synthesize，不产生任何中间文件，
 * 行为与未引入分段前完全一致。
 *
 * deps 仅供测试注入假实现，生产调用不要传。
 */
export async function synthesizeLong (
  opts: SynthesizeOptions,
  deps: { synthesize?: typeof synthesize; probe?: typeof probeDurationMs } = {}
): Promise<LongTtsResult> {
  const synth = deps.synthesize ?? synthesize
  const probe = deps.probe ?? probeDurationMs

  const chunks = splitScript(opts.text)

  // 直通：不切段就不碰拼接，少一层出错的可能
  if (chunks.length === 1) {
    const r = await synth(opts)
    return { ...r, segmentCount: 1 }
  }

  const dir = dirname(opts.outPath)
  const stem = basename(opts.outPath, '.mp3')
  const parts: string[] = []
  const words: WordTiming[] = []
  let offsetMs = 0

  try {
    // 用 entries() 而不是 chunks[i]：tsconfig 开了 noUncheckedIndexedAccess，
    // chunks[i] 的类型是 string | undefined，过不了 tsc。
    for (const [i, chunk] of chunks.entries()) {
      const partPath = join(dir, `${stem}.part${i}.mp3`)
      // 【先登记再合成】：synth 抛错时文件可能已经落盘了一半，
      // 顺序反过来的话 finally 就漏清这一个。
      parts.push(partPath)
      const r = await synth({ ...opts, text: chunk, outPath: partPath })

      words.push(...shiftWords(r.words, offsetMs))

      // 【关键】偏移量取【实测文件时长】，不是估算、也不是末词结束时间。
      // 末词念完后还有尾音静音，用末词时间会让每段少算一截，
      // 而误差是累积的——段数越多，后面的字幕偏得越离谱。
      offsetMs += await probe(partPath) + SEGMENT_GAP_MS
    }

    await concatAudio(parts, opts.outPath)

    return {
      audioPath: opts.outPath,
      words,
      durationMs: await probe(opts.outPath),
      segmentCount: chunks.length,
    }
  } finally {
    // 分段文件是中间产物，无论成败都清掉，别在用户的素材目录里留垃圾
    await Promise.all(parts.map((p) => unlink(p).catch(() => {})))
  }
}
```

（`shiftWords` 与 `WordTiming` 的 import 已在 Task 3 建立，合并 import 语句即可。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tts/long.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 移除 azure.ts 的长度拒绝**

删除 `src/tts/azure.ts` 中 `synthesize()` 开头的这段，以及不再被使用的 `REJECTION_SAFETY_MARGIN` 常量：

```typescript
  const est = estimateAudioMs(opts.text.length)
  if (est * REJECTION_SAFETY_MARGIN > MAX_AUDIO_MS) {
    throw new Error(...)
  }
```

`estimateAudioMs` 保留——`splitScript` 现在是它的使用者。

- [ ] **Step 6: 跑全套测试**

Run: `npm test`
Expected: 全绿。基线随任务推进而变化——**不要照抄计划里的数字**，
以你开工前跑出来的实际值为准，只确认「没有变少、没有失败」。

- [ ] **Step 7: 提交**

```bash
git add src/tts/long.ts src/tts/azure.ts tests/tts/long.test.ts
git commit -m "feat(tts): synthesizeLong 自动分段合成，偏移量取实测时长"
```

---

### Task 5: 接口接入 + 前端提示

**Files:**
- Modify: `src/tts/routes.ts:12,38-42`
- Modify: `src/tts/index.ts`
- Modify: `web/src/components/VoicePanel.tsx`
- Modify: `web/src/api/client.ts`（若配音响应有类型定义）

**Interfaces:**
- Consumes: `synthesizeLong`、`LongTtsResult`
- Produces: 配音接口响应新增 `segmentCount: number`

- [ ] **Step 1: 改后端路由**

`src/tts/routes.ts`：删掉 `MAX_AUDIO_MS` 常量与那段长度拦截（第 12 行、第 38–42 行），把 `synthesize(...)` 换成 `synthesizeLong(...)`，并把 `segmentCount` 放进响应体。

- [ ] **Step 2: 前端显示分段数**

`VoicePanel.tsx`：配音成功后，若 `segmentCount > 1`，在状态行下方加一句说明。**用现有的 ink-400 说明文字样式，不要新造视觉元素**：

```tsx
{segmentCount > 1 && (
  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">
    文案较长，已分 {segmentCount} 段合成并自动拼接。
    段落衔接处语气可能略有变化。
  </p>
)}
```

- [ ] **Step 3: 端到端实测（真调 Azure，会消耗配额）**

用一篇约 11 分钟的文案（约 3400 字）跑通「生成配音 → 导出」，然后**必须验证接缝处**：

```bash
# 1. 确认分了段
#    前端应显示「已分 2 段合成」

# 2. 确认音频总时长合理（约 11 分钟 = 660 秒）
ffprobe -v error -show_entries format=duration -of csv=p=0 <配音路径>

# 3. 【最重要】抽取接缝【之后】的画面，确认字幕没有漂移。
#    若段1时长 472 秒，就抽 480 秒和 650 秒（接近结尾）两帧：
ffmpeg -ss 480 -i <成片> -frames:v 1 /tmp/seam.png
ffmpeg -ss 650 -i <成片> -frames:v 1 /tmp/tail.png
#    看这两帧的字幕文字，是否与该时刻音频里正在念的内容一致。
#    结尾那帧尤其关键——累积漂移在结尾最明显。
```

- [ ] **Step 4: 更新文档**

- `docs/superpowers/specs/2026-07-16-surejack-design.md:171` —— 改掉「超过 10 分钟的文案直接拒绝」，改为说明自动分段策略，并记录「10 分钟是 F0 与 S0 共同的单次上限，非免费层限制」。
- 同文件第 316 行的风险表：「文案超 10 分钟音频」一行的对策改为自动分段。

- [ ] **Step 5: 提交**

```bash
git add src/tts/ web/src/components/VoicePanel.tsx docs/
git commit -m "feat(tts): 长文案自动分段合成接入接口与前端"
```

---

## 完成标准

- [ ] 11 分钟文案能一次生成配音，无需手工拆项目
- [ ] 成片结尾处的字幕与音频对得上（无累积漂移）
- [ ] 短文案行为与改动前完全一致（走直通路径）
- [ ] 中间的 `.partN.mp3` 文件不残留
- [ ] 全套测试绿
