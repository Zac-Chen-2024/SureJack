# SureJack 阶段 0：地基验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小代价验证四个架构假设。任何一个不成立，设计文档都要改——现在花半天，好过写两周后返工。

**Architecture:** 每个任务是一个独立的 spike，产出一个明确的 go/no-go 结论，写进 `docs/superpowers/spikes/RESULTS.md`。**spike 代码是一次性的**，验证完就扔，不进生产代码。

**Tech Stack:** ffmpeg + libass、JASSUB、Azure Speech SDK、antiword/catdoc、Node 24

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-16-surejack-design.md`。本计划验证其中第 15 节列出的风险。
- **spike 产物放 `spikes/` 目录，不放 `src/`。** 这些代码的唯一目的是回答问题，不是被复用。
- **不能碰 `/etc/nginx/sites-enabled/plus.drziangchen.uk`**——那是生产中的另一个服务。
- 域名：`surejack.zacchen.win` → `130.245.136.191`（Cloudflare DNS only，已验证解析正确）。
- 每个 spike 的结论必须写进 `docs/superpowers/spikes/RESULTS.md`，包括**失败的结论**。失败的 spike 和成功的一样有价值。
- 字体统一用 Noto Sans SC（`fonts-noto-cjk` 包）。**ffmpeg 和 JASSUB 必须用同一个字体文件**，否则"两端同一渲染器"的保证就破了。

---

## Task 1: 安装 ffmpeg 与字体，验证 libass 可用

**Files:**
- Create: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Produces: 系统上可用的 `ffmpeg`（含 libass）、Noto Sans SC 字体文件的绝对路径（后续所有任务都要用）

- [ ] **Step 1: 安装 ffmpeg、字体和 .doc 解析工具**

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-cjk antiword catdoc
```

- [ ] **Step 2: 验证 ffmpeg 编译时带了 libass**

Run: `ffmpeg -hide_banner -filters 2>/dev/null | grep -E '\bass\b|subtitles'`

Expected: 输出中同时包含 `ass` 和 `subtitles` 两个滤镜。类似：
```
 T.. ass               V->V       Render ASS subtitles onto input video using the libass library.
 T.. subtitles         V->V       Render text subtitles onto input video using the libass library.
```

**如果没有 `ass` 滤镜**：说明这个 ffmpeg 没编 libass 支持，整个字幕方案作废。此时停下来报告，不要继续。

- [ ] **Step 3: 找到字体文件的确切路径和字体族名**

Run: `fc-list | grep -i "noto sans sc" | head -5`

Expected: 输出若干行，形如 `/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc: Noto Sans SC,思源黑体...`

记下**文件绝对路径**和**字体族名**（`Noto Sans SC`）。ASS 样式里的 `Fontname` 必须和字体族名**精确匹配**，拼错的表现是"字幕不显示"或"渲染成方块"，而且不报错——这是个很难查的坑。

- [ ] **Step 4: 记录结论**

创建 `docs/superpowers/spikes/RESULTS.md`：

```markdown
# 地基验证结论

> 每个 spike 的结论记在这里，包括失败的。日期：2026-07-16

## Spike 1: ffmpeg + libass + 字体

- **结论**：待填（GO / NO-GO）
- ffmpeg 版本：
- libass 滤镜可用：
- 字体文件路径：
- 字体族名：
```

把实际值填进去。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证 ffmpeg libass 与中文字体可用"
```

---

## Task 2: 验证 ASS 卡拉OK 烧录（整个架构的地基）

**这是最重要的一个 spike。** 设计文档里"字幕和固定文本统一为 ASS、两端同一个 libass"的整个架构，都压在 `\kf` 标签真的能渲染这个假设上。我宣称它成立，但没实测过。

**Files:**
- Create: `spikes/karaoke/test.ass`
- Create: `spikes/karaoke/check_karaoke.py`
- Create: `spikes/karaoke/run.sh`
- Modify: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Consumes: Task 1 的字体路径和字体族名
- Produces: `\kf` 是否可用的结论；一个可用的 ASS 样式模板（后续 `subtitles/` 模块直接照抄）

- [ ] **Step 1: 写测试用的 ASS 文件**

创建 `spikes/karaoke/test.ass`。**注意 ASS 的颜色是 `&HAABBGGRR` 格式，BGR 顺序不是 RGB**，这是个经典陷阱：

```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Noto Sans SC,90,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,0,2,40,40,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:06.00,Karaoke,,0,0,0,,{\kf100}震{\kf100}惊{\kf100}我{\kf100}的{\kf100}天{\kf100}啊
```

关键点解释（后面写生产代码时要用）：
- `PrimaryColour` = **已唱**的颜色（这里黄色 `&H0000FFFF`）
- `SecondaryColour` = **未唱**的颜色（这里白色 `&H00FFFFFF`）
- `\kf100` = 这个字持续 100 厘秒 = 1 秒，`\kf` 是扫光填充（`\k` 是整字跳变）
- `Alignment: 2` = 底部居中，`MarginV: 300` = 距底部 300px
- `WrapStyle: 2` = 不自动换行（我们自己控制换行，绕开 libass 的中文换行问题）

- [ ] **Step 2: 写自动化检查脚本**

肉眼看容易自欺欺人（"好像是变了？"）。用像素统计给出客观答案。

创建 `spikes/karaoke/check_karaoke.py`。**纯标准库，无第三方依赖**：

```python
#!/usr/bin/env python3
"""从烧录好的视频里抽帧，统计黄色像素数量，验证卡拉OK扫光确实在推进。

原理：\kf 生效时，随时间推移「已唱」的黄色部分应该单调增加。
如果三个时间点的黄色像素数几乎不变，说明 \kf 没生效（整行一个颜色）。
"""
import subprocess
import sys

VIDEO = "spikes/karaoke/out.mp4"
TIMESTAMPS = [0.5, 3.0, 5.5]


def extract_ppm(video: str, ts: float) -> bytes:
    """抽一帧，输出 P6 格式的 PPM 原始数据。"""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", str(ts), "-i", video, "-vframes", "1",
         "-pix_fmt", "rgb24", "-f", "image2pipe", "-vcodec", "ppm", "-"],
        capture_output=True, check=True,
    )
    return proc.stdout


def count_yellow(ppm: bytes) -> int:
    """数黄色像素（高 R、高 G、低 B）。"""
    # PPM 头：P6\n<宽> <高>\n<最大值>\n，然后是原始 RGB 字节
    parts = ppm.split(b"\n", 3)
    if parts[0] != b"P6":
        raise ValueError(f"不是 P6 格式的 PPM：{parts[0]!r}")
    pixels = parts[3]

    count = 0
    for i in range(0, len(pixels) - 2, 3):
        r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
        if r > 180 and g > 180 and b < 100:
            count += 1
    return count


def main() -> int:
    counts = []
    for ts in TIMESTAMPS:
        n = count_yellow(extract_ppm(VIDEO, ts))
        counts.append(n)
        print(f"  t={ts:>4}s  黄色像素 = {n:>7}")

    print()
    if counts[0] == 0 and counts[-1] == 0:
        print("❌ 失败：全程没有黄色像素。字幕可能根本没渲染出来")
        print("   排查：ASS 里的 Fontname 和 fc-list 报的字体族名是否精确一致？")
        return 1

    if not (counts[0] < counts[1] < counts[2]):
        print("❌ 失败：黄色像素没有随时间单调增加")
        print(f"   实测：{counts}")
        print("   说明 \\kf 扫光没有生效——整行可能是同一个颜色")
        return 1

    print(f"✅ 通过：黄色像素单调增加 {counts[0]} → {counts[1]} → {counts[2]}")
    print("   \\kf 卡拉OK 扫光在 libass 里确实生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: 写烧录脚本**

创建 `spikes/karaoke/run.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FONTSDIR="/usr/share/fonts/opentype/noto"   # 用 Task 1 查到的实际路径替换

echo "→ 生成 6 秒纯黑背景（1080x1920 竖屏）"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1080x1920:d=6:r=30" \
  -c:v libx264 -pix_fmt yuv420p \
  spikes/karaoke/bg.mp4

echo "→ 烧录卡拉OK字幕"
ffmpeg -hide_banner -loglevel error -y \
  -i spikes/karaoke/bg.mp4 \
  -vf "ass=spikes/karaoke/test.ass:fontsdir=${FONTSDIR}" \
  -c:v libx264 -pix_fmt yuv420p \
  spikes/karaoke/out.mp4

echo "→ 抽帧检查扫光是否推进"
python3 spikes/karaoke/check_karaoke.py
```

- [ ] **Step 4: 运行，预期通过**

Run:
```bash
chmod +x spikes/karaoke/run.sh && ./spikes/karaoke/run.sh
```

Expected:
```
→ 生成 6 秒纯黑背景（1080x1920 竖屏）
→ 烧录卡拉OK字幕
→ 抽帧检查扫光是否推进
  t= 0.5s  黄色像素 =    ...
  t= 3.0s  黄色像素 =    ...
  t= 5.5s  黄色像素 =    ...

✅ 通过：黄色像素单调增加 ... → ... → ...
   \kf 卡拉OK 扫光在 libass 里确实生效
```

**如果失败**：
- 全程 0 个黄色像素 → 十有八九是 `Fontname` 和字体族名对不上。用 Task 1 记的族名替换 `test.ass` 里的 `Noto Sans SC`，重跑。
- 有黄色但不递增 → `\kf` 真的不生效。**这是 NO-GO**，停下来报告，设计文档第 7 节要改（退回只做整行显示，或改用逐帧 Canvas 渲染）。

- [ ] **Step 5: 人工确认一眼**

自动检查只证明"颜色在变"，不证明"看起来对"。抽一帧亲眼看：

```bash
ffmpeg -hide_banner -loglevel error -y -ss 3.0 -i spikes/karaoke/out.mp4 \
  -vframes 1 spikes/karaoke/frame_3s.png
```

确认 `frame_3s.png` 里：中文字正常显示（不是方块、不是缺字）、前三个字是黄色、后三个字是白色、描边清晰。

- [ ] **Step 6: 记录结论并提交**

把结论追加到 `docs/superpowers/spikes/RESULTS.md`：

```markdown
## Spike 2: ASS 卡拉OK（\kf）

- **结论**：待填（GO / NO-GO）
- 像素统计：t=0.5s / t=3.0s / t=5.5s → ? / ? / ?
- 人工确认中文渲染正常：是 / 否
- 可用的 ASS 样式模板：见 spikes/karaoke/test.ass
- **对设计的影响**：（NO-GO 的话写清楚第 7 节要怎么改）
```

```bash
git add spikes/karaoke docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证 ASS \\kf 卡拉OK 在 libass 中生效"
```

---

## Task 3: 验证 JASSUB 浏览器渲染与烧录一致

设计文档的核心主张是**"同一个 libass、同一个文件、同样的像素"**。Task 2 证明了烧录那一端，这个任务证明浏览器那一端，并确认两端**看起来真的一样**。

**Files:**
- Create: `spikes/jassub/index.html`
- Create: `spikes/jassub/serve.sh`
- Modify: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Consumes: Task 2 的 `test.ass` 和 `out.mp4`、Task 1 的字体路径
- Produces: JASSUB 可用性结论；字体加载耗时的实测数据

- [ ] **Step 1: 装 JASSUB 并把资源准备好**

```bash
mkdir -p spikes/jassub
cd spikes/jassub
npm init -y
npm install jassub
# JASSUB 不能用系统字体，必须显式提供字体文件——这正是「两端同一个文件」的落点
cp /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc ./NotoSansCJK-Bold.ttc
cp ../karaoke/test.ass ./test.ass
cp ../karaoke/bg.mp4 ./bg.mp4
cd -
```

（字体文件路径用 Task 1 查到的实际值。）

- [ ] **Step 2: 写最小验证页面**

创建 `spikes/jassub/index.html`：

```html
<!doctype html>
<meta charset="utf-8">
<title>JASSUB 卡拉OK 验证</title>
<style>
  body { background:#111; color:#eee; font-family:system-ui; padding:20px; }
  #wrap { position:relative; width:360px; }
  video { width:360px; display:block; }
  #log { margin-top:16px; font-family:monospace; font-size:13px; white-space:pre; }
</style>

<h3>JASSUB 渲染 test.ass（应与 out.mp4 烧录结果一致）</h3>
<div id="wrap">
  <video id="v" src="bg.mp4" controls autoplay muted loop></video>
</div>
<div id="log">加载中…</div>

<script type="module">
  import JASSUB from './node_modules/jassub/dist/jassub.es.js'

  const log = (m) => { document.getElementById('log').textContent += '\n' + m }
  document.getElementById('log').textContent = '开始加载字体…'

  const t0 = performance.now()
  const fontBuf = await fetch('./NotoSansCJK-Bold.ttc').then(r => r.arrayBuffer())
  const fontMs = Math.round(performance.now() - t0)
  log(`字体加载完成：${(fontBuf.byteLength / 1048576).toFixed(1)} MB，耗时 ${fontMs} ms`)

  new JASSUB({
    video: document.getElementById('v'),
    subUrl: './test.ass',
    workerUrl: './node_modules/jassub/dist/jassub-worker.js',
    wasmUrl: './node_modules/jassub/dist/jassub-worker.wasm',
    fonts: [new Uint8Array(fontBuf)],
    availableFonts: { 'noto sans sc': new Uint8Array(fontBuf) },
    fallbackFont: 'noto sans sc',
  })

  log('JASSUB 已启动。请确认字幕出现且黄色扫光随播放推进。')
</script>
```

- [ ] **Step 3: 起个本地服务器**

创建 `spikes/jassub/serve.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "打开 http://<服务器IP>:8099/"
python3 -m http.server 8099
```

Run:
```bash
chmod +x spikes/jassub/serve.sh && ./spikes/jassub/serve.sh
```

- [ ] **Step 4: 浏览器里确认，并与烧录结果对比**

在浏览器打开页面，确认三件事：

1. **字幕出现了**，中文正常（不是方块）
2. **黄色扫光随播放推进**——和 Task 2 的 `out.mp4` 是同一个效果
3. **把 `frame_3s.png` 和浏览器里 3 秒处的画面并排看**：字号、位置、描边粗细、断字位置应该**看起来一致**

第 3 点是这个 spike 的真正目的。**如果两边明显不一样**（比如字号差很多、位置偏了），说明"两端同一渲染器"的保证没兑现，通常是 `PlayResX/Y` 和视频实际分辨率对不上，或者字体没正确传给 JASSUB。这属于**必须解决才能继续**的问题，不是"以后再调"。

记下页面上报的**字体加载耗时和体积**——设计文档第 7 节说了这十几 MB 会有感知，现在拿到实测数字。

- [ ] **Step 5: 记录结论并提交**

追加到 `docs/superpowers/spikes/RESULTS.md`：

```markdown
## Spike 3: JASSUB 浏览器渲染

- **结论**：待填（GO / NO-GO）
- JASSUB 版本：
- 字体体积 / 加载耗时：? MB / ? ms
- 与烧录结果目视一致：是 / 否（不一致的话写清差异）
- **对设计的影响**：
```

```bash
git add spikes/jassub docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证 JASSUB 浏览器渲染与 ffmpeg 烧录一致"
```

> `spikes/jassub/node_modules/` 会被根目录 `.gitignore` 里的 `node_modules/` 规则排除，字体和视频文件体积较大，也不要提交——只提交 `index.html`、`serve.sh`、`package.json` 和结论。

---

## Task 4: 验证 443 入站可达

**这条不通，HTTPS 就没了，"公网 + 真实认证"整个前提当场崩塌。** 80 端口已确认可达（`plus.drziangchen.uk` 在跑就是证据），但 443 目前无人监听，云安全组或防火墙挡住它是**非常常见**的情况。

**Files:**
- Modify: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Produces: 443 是否可达的结论。这决定了阶段 2（部署）能不能按设计走

- [ ] **Step 1: 确认 443 当前确实没人监听**

Run: `sudo ss -tlnp | grep ':443' || echo "443 空闲，可以测试"`

Expected: `443 空闲，可以测试`

**如果有人在监听**：停下来查清是谁——可能是另一个服务，不能随便占。

- [ ] **Step 2: 在 443 上临时起一个监听**

```bash
sudo python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'SUREJACK_443_OK')
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', 443), H) as s:
    print('监听 0.0.0.0:443，等待外部连接…')
    s.serve_forever()
"
```

这是个**明文 HTTP** 服务器，只是恰好开在 443 端口上。我们测的是**TCP 层能不能连进来**，和 TLS 无关——先确认路通，再谈证书。

- [ ] **Step 3: 从外部验证能连进来**

**本机 curl 自己是没有意义的**（走 loopback，绕过了防火墙和安全组）。必须从外部发起。

首选，用第三方检测服务：

```bash
curl -s "https://check-host.net/check-tcp?host=surejack.zacchen.win:443&max_nodes=3" \
  -H "Accept: application/json"
```

拿到返回的 `request_id` 后查结果：

```bash
curl -s "https://check-host.net/check-result/<request_id>" -H "Accept: application/json"
```

Expected: 至少一个节点返回 `"address"` 且没有 `"error"`，说明 TCP 握手成功。

**备用方案（更可靠，推荐直接用这个）**：让用户**用手机关掉 WiFi、走蜂窝数据**打开 `http://surejack.zacchen.win:443`，看到 `SUREJACK_443_OK` 就是通的。关 WiFi 是关键——否则可能走的是内网。

- [ ] **Step 4: 关掉临时监听**

按 `Ctrl+C` 停掉。**别把这个明文服务器忘在 443 上开着。**

- [ ] **Step 5: 记录结论并提交**

追加到 `docs/superpowers/spikes/RESULTS.md`：

```markdown
## Spike 4: 443 入站可达性

- **结论**：待填（GO / NO-GO）
- 验证方式：check-host.net / 手机蜂窝数据
- 实际结果：
- **NO-GO 的话**：需要开云安全组/防火墙的 443 入站；若无权限，
  则只能退回 Cloudflare 橙色云代理——但那会撞上 100MB 上传上限，
  等于废掉视频上传，设计文档第 16 节必须重写
```

```bash
git add docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证 443 入站可达性"
```

---

## Task 5: 验证 Azure zh-CN 字级时间戳

**前置条件（需要用户操作）**：注册 Azure、创建 Speech 资源、**选 F0 免费层**、拿到 key 和 region。这个 spike 在拿到 key 之前无法开始。

**Files:**
- Create: `spikes/azure-tts/probe.mjs`
- Create: `spikes/azure-tts/.env.example`
- Modify: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Produces: zh-CN 字级时间戳的真实形态。这直接决定 `subtitles/` 模块的断句逻辑怎么写

- [ ] **Step 1: 装 SDK**

```bash
mkdir -p spikes/azure-tts && cd spikes/azure-tts
npm init -y && npm pkg set type=module
npm install microsoft-cognitiveservices-speech-sdk dotenv
cd -
```

创建 `spikes/azure-tts/.env.example`：

```
AZURE_SPEECH_KEY=在这里填你的 key
AZURE_SPEECH_REGION=eastus
```

用户按这个建一个 `.env`（**已被根 `.gitignore` 排除，绝不能提交**）。

- [ ] **Step 2: 写探测脚本**

创建 `spikes/azure-tts/probe.mjs`：

```javascript
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'

// 故意包含：标点、数字、英文缩写。都是营销号文案里的常客。
const TEXT = '震惊！这个方法99%的人都不知道，AI一秒搞定，你还在等什么？'

const key = process.env.AZURE_SPEECH_KEY
const region = process.env.AZURE_SPEECH_REGION
if (!key || !region) {
  console.error('缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，请先建 .env')
  process.exit(1)
}

const config = sdk.SpeechConfig.fromSubscription(key, region)
config.speechSynthesisVoiceName = 'zh-CN-XiaoxiaoNeural'
config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3

const audio = sdk.AudioConfig.fromAudioFileOutput('spikes/azure-tts/out.mp3')
const synth = new sdk.SpeechSynthesizer(config, audio)

const events = []
synth.wordBoundary = (_s, e) => {
  events.push({
    text: e.text,
    // audioOffset 单位是 100 纳秒（HNS），除以 10000 得毫秒
    offsetMs: e.audioOffset / 10000,
    durationMs: e.duration / 10000,
    textOffset: e.textOffset,
    wordLength: e.wordLength,
    boundaryType: e.boundaryType,
  })
}

console.log(`合成中：「${TEXT}」\n`)

synth.speakTextAsync(
  TEXT,
  (result) => {
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      console.error('合成失败：', result.errorDetails)
      synth.close()
      process.exit(1)
    }

    console.log(`音频总时长：${(result.audioDuration / 10000).toFixed(0)} ms`)
    console.log(`WordBoundary 事件数：${events.length}\n`)
    console.log('序号  类型          起始(ms)  时长(ms)  文本')
    console.log('─'.repeat(56))
    for (const [i, e] of events.entries()) {
      const type = String(e.boundaryType).padEnd(12)
      console.log(
        `${String(i).padStart(3)}  ${type}  ${String(Math.round(e.offsetMs)).padStart(8)}  ` +
        `${String(Math.round(e.durationMs)).padStart(8)}  ${e.text}`
      )
    }

    const punct = events.filter((e) => String(e.boundaryType).toLowerCase().includes('punct'))
    console.log(`\n标点类事件：${punct.length} 个 → ${punct.map((p) => p.text).join(' ')}`)
    console.log(
      punct.length > 0
        ? '✅ 标点会单独触发事件——断句可以直接用它，不需要自己分词'
        : '❌ 没有标点事件——断句逻辑必须自己写，设计文档第 7 节要改'
    )

    writeFileSync('spikes/azure-tts/timings.json', JSON.stringify(events, null, 2))
    console.log('\n完整时间戳已写入 spikes/azure-tts/timings.json')
    synth.close()
  },
  (err) => {
    console.error('出错：', err)
    synth.close()
    process.exit(1)
  }
)
```

- [ ] **Step 3: 运行**

Run: `node spikes/azure-tts/probe.mjs`

Expected: 打印出一张事件表，且**标点类事件数 > 0**。类似：

```
音频总时长：6800 ms
WordBoundary 事件数：24

序号  类型          起始(ms)  时长(ms)  文本
────────────────────────────────────────────────────────
  0  Word                50       280  震惊
  1  Punctuation        330        60  ！
  ...

标点类事件：4 个 → ！ ， ， ？
✅ 标点会单独触发事件——断句可以直接用它，不需要自己分词
```

- [ ] **Step 4: 核对四件事**

这个 spike 的价值全在这里，不要跳过：

1. **标点是否单独触发事件** —— 设计文档第 7 节的断句逻辑完全依赖这一点
2. **中文是怎么切词的** —— 是逐字，还是"震惊"这样成词？这决定卡拉OK `\kf` 的粒度
3. **`99%` 和 `AI` 怎么处理** —— 数字和英文在中文里的边界行为
4. **时间戳是否单调递增、有无重叠** —— 断句算法的基本假设

**顺便验证一个坑**：把 `TEXT` 改成含 `&` 的（比如 `震惊！A&B公司的秘密`），重跑，看时间戳是否从 `&` 之后开始错乱。这验证的是设计文档第 5 节那条"必须清洗特殊字符"的依据。

- [ ] **Step 5: 记录结论并提交**

追加到 `docs/superpowers/spikes/RESULTS.md`：

```markdown
## Spike 5: Azure zh-CN 字级时间戳

- **结论**：待填（GO / NO-GO）
- SDK 版本 / 音色 / region：
- 标点是否单独触发事件：是 / 否
- 中文切词粒度：逐字 / 成词
- 数字（99%）和英文（AI）的边界行为：
- 含 `&` 时时间戳是否错乱：是 / 否（验证第 5 节清洗要求）
- 完整样本：spikes/azure-tts/timings.json
- **对设计的影响**：
```

```bash
git add spikes/azure-tts/probe.mjs spikes/azure-tts/.env.example \
        spikes/azure-tts/timings.json docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证 Azure zh-CN 字级时间戳与标点事件"
```

**确认 `.env` 和 `out.mp3` 没被提交**：`git status --ignored | grep -E 'env|mp3'`

---

## Task 6: 验证中文 .doc 解析

**前置条件（需要用户操作）**：提供一个**真实的中文 `.doc` 文件**（Word 2003 格式）。自己造的测试文件没有代表性——真实文件里的编码、样式、来源千奇百怪，而这个 spike 要验的恰恰就是"真实世界的中文老 .doc 能不能读"。

**Files:**
- Create: `spikes/doc-parse/compare.sh`
- Modify: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Produces: `.doc` 用哪个工具、还是干脆不支持的结论。直接决定 `importers/` 模块怎么写

- [ ] **Step 1: 放入样本文件**

```bash
mkdir -p spikes/doc-parse/samples
# 用户把真实的中文 .doc 放进 spikes/doc-parse/samples/
ls -la spikes/doc-parse/samples/
```

- [ ] **Step 2: 写对比脚本**

创建 `spikes/doc-parse/compare.sh`：

```bash
#!/usr/bin/env bash
set -uo pipefail   # 注意：不用 -e，某个工具失败是预期内的结果，不该中断

cd "$(git rev-parse --show-toplevel)"

for f in spikes/doc-parse/samples/*.doc; do
  [ -e "$f" ] || { echo "samples/ 里没有 .doc 文件"; exit 1; }
  echo "═══════════════════════════════════════════════"
  echo "样本：$f"
  echo "═══════════════════════════════════════════════"

  echo "--- antiword（默认）---"
  antiword "$f" 2>&1 | head -6

  echo "--- antiword -m UTF-8.txt ---"
  antiword -m UTF-8.txt "$f" 2>&1 | head -6

  echo "--- catdoc（默认）---"
  catdoc "$f" 2>&1 | head -6

  echo "--- catdoc -d utf-8 ---"
  catdoc -d utf-8 "$f" 2>&1 | head -6

  echo
done
```

- [ ] **Step 3: 运行并判读**

Run:
```bash
chmod +x spikes/doc-parse/compare.sh && ./spikes/doc-parse/compare.sh
```

**怎么判读**：找出哪个命令输出的**中文是可读的**，而不是乱码（`???`、`ä½ å¥½`、`\x{...}` 这类）。

设计文档第 5 节预判 `antiword`（2005 年的东西）对中日韩支持弱、`catdoc -d utf-8` 更可能成功。**这个 spike 就是来证实或推翻这个预判的。**

- [ ] **Step 4: 验证「失败要能被检测出来」**

这一步比上一步更重要。**乱码悄悄流进配音环节，比直接报错糟糕得多。**

拿一个**非 .doc 的文件**冒充 `.doc` 试试：

```bash
echo "这不是一个真正的 doc 文件" > /tmp/fake.doc
antiword /tmp/fake.doc; echo "antiword 退出码：$?"
catdoc /tmp/fake.doc; echo "catdoc 退出码：$?"
```

记下：**工具在失败时是返回非零退出码，还是照样返回 0 但吐垃圾？** 这决定了 `importers/` 里的失败检测怎么写。如果退出码不可靠，就得靠"输出里可读中文字符的比例"这类启发式判断。

- [ ] **Step 5: 记录结论并提交**

追加到 `docs/superpowers/spikes/RESULTS.md`：

```markdown
## Spike 6: 中文 .doc 解析

- **结论**：待填（GO / 部分支持 / NO-GO）
- 样本来源与数量：
- antiword 默认 / -m UTF-8.txt：可读 / 乱码
- catdoc 默认 / -d utf-8：可读 / 乱码
- **选定方案**：
- 失败时退出码是否可靠：是 / 否（否 → importers 要用启发式检测）
- **对设计的影响**：（都不行的话，第 5 节的 .doc 支持降级为「明确拒绝并提示另存为 .docx」）
```

```bash
git add spikes/doc-parse/compare.sh docs/superpowers/spikes/RESULTS.md
git commit -m "spike: 验证中文 .doc 解析工具选型"
```

> 样本 `.doc` 文件不要提交——可能含用户真实内容。在 `.gitignore` 里加一行 `spikes/doc-parse/samples/`。

---

## Task 7: 汇总结论，决定后续计划是否需要修订

**Files:**
- Modify: `docs/superpowers/spikes/RESULTS.md`
- Modify: `docs/superpowers/specs/2026-07-16-surejack-design.md`（仅在有 spike 失败时）

- [ ] **Step 1: 通读 RESULTS.md，逐条对照设计文档第 15 节**

第 15 节列了 6 条风险。确认每条都有了明确的 GO / NO-GO 结论，**没有一条是"大概可以"**。

- [ ] **Step 2: 把失败的 spike 转化为设计变更**

对每个 NO-GO，在设计文档里改掉对应章节，并在提交信息里说清楚**为什么改**。参照的影响路径：

| 失败的 spike | 要改的地方 |
|---|---|
| `\kf` 不生效 | 第 7 节：砍掉卡拉OK模式，或改用逐帧 Canvas 渲染（成本大增） |
| JASSUB 与烧录不一致 | 第 7、11 节：「两端同一渲染器」的保证失效，预览方案要重想 |
| 443 不通 | 第 16 节：HTTPS 方案作废；退回 Cloudflare 代理则撞 100MB 上限，视频上传功能要重新设计 |
| 无标点事件 | 第 7 节：断句要自己实现中文分词 |
| .doc 全乱码 | 第 5 节：.doc 降级为明确拒绝 + 提示另存为 .docx |

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "spike: 汇总地基验证结论"
```

- [ ] **Step 4: 报告并交回决策**

向用户汇报：**每条风险的结论、哪些假设被推翻了、设计文档改了什么**。然后确认是否按原计划进入阶段 1（生成管线）。

**如果全部 GO**：架构成立，直接进阶段 1。
**如果有 NO-GO**：先和用户一起把设计改定，再写阶段 1 的计划——**别拿着一份已知有错的设计往下写代码。**
