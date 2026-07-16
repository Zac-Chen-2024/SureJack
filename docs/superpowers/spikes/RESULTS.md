# 地基验证结论

> 对应设计文档第 15 节列出的风险。每个 spike 的结论记在这里，**包括失败的**。
> 日期：2026-07-16　分支：`spike/phase0-foundation`

## Spike 1: ffmpeg + libass + 中文字体

- **结论**：✅ **GO**
- **ffmpeg 版本**：4.4.2-0ubuntu0.22.04.1（Ubuntu 22.04 源，2021 年版本，偏旧但够用）
- **libass 滤镜可用**：是。`ass` 和 `subtitles` 滤镜均存在，编译选项含 `--enable-libass`
- **字体目录（ffmpeg `fontsdir` 用）**：`/usr/share/fonts/opentype/noto`
- **字体文件**：
  - 粗体：`/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc` —— **20.0 MB**
  - 常规：`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` —— 19.5 MB
- **`.doc` 工具**：`antiword` 0.37 和 `catdoc` 0.95 均已安装

### ⚠️ 发现：字体族名和计划里写的不一样

**计划假设族名是 `Noto Sans SC`，这是错的。实际是 `Noto Sans CJK SC`。**

```
$ fc-match "Noto Sans SC"
DejaVuSans.ttf: "DejaVu Sans" "Book"      ← 回退了！这个族名不存在

$ fc-match "Noto Sans CJK SC"
NotoSansCJK-Regular.ttc: "Noto Sans CJK SC" "Regular"   ← 正确
```

**为什么这值得单独记一笔**：`fc-match` 找不到字体时会**静默回退**到 DejaVu Sans，而 DejaVu 一个中文字都没有。如果 ASS 里写错族名，表现是**字幕渲染成方块或完全不显示，且 ffmpeg 不报任何错误**——这正是设计文档第 7 节担心的那类"两端不一致"问题的源头之一。

**对后续的影响**：所有 ASS 样式的 `Fontname` 必须写 `Noto Sans CJK SC`。生产代码里这个值应该是**配置常量，不是散落的字符串字面量**，并且启动时应该校验字体确实可解析。

### 待验证的新问题

`.ttc` 是**字体集合**（一个文件里打包了 SC/TC/JP/KR/HK 多个字体）。ffmpeg/fontconfig 处理 `.ttc` 没问题，但 **JASSUB 直接吃一个 `.ttc` 的 buffer 能不能正确解析集合、能不能选中 SC 那个，尚不确定** —— Spike 3 验证。

---

## Spike 2: ASS 卡拉OK（\kf）

- **结论**：✅ **GO** —— 这是最关键的一条，整个「字幕统一为 ASS + 两端同一 libass」架构压在它上面

### 像素统计（自动化，不靠肉眼）

| 时间 | 黄色（已唱） | 白色（未唱） | 合计 |
|---|---|---|---|
| t=0.5s | 961 | 9063 | 10024 |
| t=3.0s | 5053 | 4705 | 9758 |
| t=5.5s | 8812 | 754 | 9566 |

**黄色单调增加、白色相应减少、两者之和基本恒定**——这三条合起来才能证明发生的确实是"白字被逐个扫成黄字"，而不是别的现象（比如字幕整体闪烁或位移）。只数黄色是不够的。

### 人工确认

- t=1.0s：「震」黄，其余白 —— `\kf100` = 每字 1 秒，**扫光位置与时间戳精确吻合**
- t=3.0s：「震惊我」黄，「的天啊」白
- 中文渲染正常（无方块/无缺字）、粗体、描边清晰

### 产出

- **可用的 ASS 样式模板**：`spikes/karaoke/test.ass`，`subtitles/` 模块可直接照抄
- 关键参数（写生产代码要用）：
  - `PrimaryColour` = **已唱**色，`SecondaryColour` = **未唱**色（不是"主/次"的字面意思）
  - 颜色格式是 `&HAABBGGRR`，**BGR 顺序，不是 RGB**
  - `\kf<厘秒>` = 扫光填充；`\k` 是整字跳变（无扫光过渡）
  - `WrapStyle: 2` = 禁用自动换行，绕开 libass 的中文换行问题
  - `ScaledBorderAndShadow: yes` = 描边随分辨率缩放，保证预览与成片一致

### 对设计的影响

无需修改。设计文档第 7 节关于 `\kf` 的主张**成立**，且"卡拉OK 不用我们画任何一帧"得到证实。

## Spike 3: JASSUB 浏览器渲染

- **结论**：⏸ **暂缓** —— 无头环境验证失败，改为在真实浏览器 + 真 HTTPS 下验证（依赖 Spike 4）

### 无头环境的状况

JASSUB 在 playwright/headless chromium 里**渲染不出任何像素**。已排除的原因：

| 假设 | 排除方式 |
|---|---|
| 字体没加载 | `.ttc` 和自带的 `default.woff2` 都试过，都不渲染；用 `.ttc` 时**零字体错误** |
| WebGL 不可用 | WebGL2 经 SwiftShader 可用；禁掉 WebGL 强制回退 Canvas2D，同样不渲染 |
| 截图链路有问题 | 对照组：普通 2D canvas 画的洋红方块**能被正常截到** |
| API 用错了 | 读了随包 README，`manualRender` 确实是 canvas-only 模式的正确用法，写法与官方示例一致 |

**判断**：大概率是无头环境特有的问题，不是 JASSUB 或我们架构的问题。旁证是 JASSUB 依赖 `OffscreenCanvas` + `requestVideoFrameCallback`，**是围绕真实视频播放设计的**；而 libass-wasm 这类方案已被 Jellyfin、Crunchyroll（用 SubtitlesOctopus）在生产中大规模验证——"能不能渲染 ASS"本身不需要我们重新证明。

**真正要验的是"它和 ffmpeg 烧录的结果一不一样"**，这个用真浏览器几秒就能看出来，不值得在无头环境继续投入。

### 但这一路挖出了 5 个生产环境必踩的坑（都是真收获）

1. **必须打包。** jassub 的依赖图里有裸模块名和 CommonJS 包（`throughput` 是 CJS），浏览器原生 ES module 加载不了。生产用 Vite 会自动处理，但要知道有这回事。
2. **`workerUrl` 要指向 `dist/worker/worker.js`，不是 `dist/wasm/jassub-worker.js`。** 后者是 emscripten 的 wasm 胶水。传错的表现极其阴险：**worker 正常启动、不报任何错、`ready` 永远不解决**。（注意：**README 第 90 行写的是错的**，它落后于 2.5.7 的重构，以代码为准。）
3. **worker 打包产物要放进 `dist/wasm/` 目录**，否则 emscripten 用 `import.meta.url` 推算同目录文件时会找错位置。
4. **`manualRender` 必须调两次。** 源码 `_demandRender` 在检测到尺寸变化时会「resize 然后提前返回」，而首次调用时内部记录的宽高是 0，必然触发该分支——**第一次只 resize 不绘制**。
5. **字体必须显式提供**，JASSUB 用不了系统字体。打包后它自带的 `default.woff2` 路径会失效（`import.meta.url` 变了），需要手动放到位。

### 实测数据

- 字体 `NotoSansCJK-Bold.ttc`：**19.1 MB**，本地加载约 **150–220 ms**（公网会明显更慢，需缓存）
- jassub 版本：**2.5.7**（注意：早前网络搜索报的 "1.8.6" 是错的，以 `npm view` 为准）

---

## 先行技术调研：MoneyPrinterTurbo

[harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) —— 56K star，MIT，活跃维护，与本项目产品空间高度重叠。**已评估是否直接 clone 改造，结论：不 clone，但读它。**

### 它的技术选型（实际读码确认，非 README）

| | MoneyPrinterTurbo | SureJack |
|---|---|---|
| 字幕格式 | **SRT** | **ASS** |
| 字幕渲染 | **MoviePy `SubtitlesClip` / `TextClip`** | **libass** |
| 合成 | MoviePy `write_videofile` | 裸 ffmpeg |
| 界面 | Streamlit | React 编辑器 |
| 预览 | **无**（render-then-watch） | JASSUB 实时预览 |
| 产品形态 | 一个主题 → LLM 写文案 → 一键出片 | 文案是一等公民，可编辑、可预览 |

### 为什么不 clone

**它用 MoviePy 的 `TextClip` 渲染字幕，不是 libass。这不是风格差异，是能力差异：**

- `TextClip` **做不了卡拉OK**——它每条字幕渲染一张静态文字图，逐字扫光在这个模型里没有对应物
- MoviePy 逐帧在 Python 里跑，比裸 ffmpeg 慢一个数量级
- **它天然不可能有浏览器预览**，因为渲染发生在 Python 里——这就是 MPT 没有预览的架构原因

25,662 行代码里真正想留的不到 5%，而那 5% 是**知识不是代码**。clone 它等于接受它的产品形态（无编辑器、无预览、无卡拉OK），而编辑器和预览恰恰是本项目的差异化所在。

### 但它验证了我们两个决策

- **TTS 用 edge TTS + Azure Speech** —— 和我们的选型独立吻合
- **默认用 TTS 时间戳生成字幕**（快、不要 GPU），whisper 仅作为可选的高精度路径 —— 和我们第 6 节的方案一致

### 值得读的部分

- `app/services/voice.py`（1817 行）—— edge-tts `SubMaker` 的时间戳对齐处理
- `app/services/video.py`（1362 行）—— 实战调出来的 ffmpeg 参数
- 字幕样式默认值 —— 比拍脑袋强

## Spike 4: 443 入站可达性

- **结论**：✅ **GO** —— 完整 HTTP 请求响应通过，不只是 TCP 握手

### 验证方式

在 443 上起临时明文 HTTP 监听（测的是「路通不通」，与 TLS 无关），用 check-host.net 的多个海外节点从**真正的外部**发起请求。**本机 curl 走 loopback、绕过防火墙和安全组，证明不了任何事**，因此不作为依据。

### 结果

| 检测 | 节点 | 结果 |
|---|---|---|
| TCP 握手 | 🇪🇸 西班牙 | ✅ 连上 130.245.136.191，0.138s |
| TCP 握手 | 🇮🇹 意大利 | ✅ 连上，0.092s |
| TCP 握手 | 🇮🇳 印度 | ❌ 超时（跨洲路由问题，非服务器问题） |
| **完整 HTTP** | 🇯🇵 日本 | ✅ **HTTP 200** |
| **完整 HTTP** | 🇳🇱 荷兰 | ✅ **HTTP 200** |
| **完整 HTTP** | 🇮🇷 伊朗 | ✅ **HTTP 200** |

监听端日志坐实了外部 IP 真实连入：`195.211.27.85`、`77.104.108.3`、`103.214.169.52`。

**结论：防火墙与云安全组均未阻挡 443，数据双向流通。** 第 16 节的 HTTPS 方案成立，不需要退回 Cloudflare 代理（那会撞上 100MB 上传上限）。

### 清理

临时监听已关闭，443 已释放。`plus.drziangchen.uk` 生产服务全程未受影响（验证后 `/api/health` 与 `/docs` 均为 200，nginx active）。

## Spike 5: Azure zh-CN 字级时间戳

- **结论**：阻塞中——等待用户提供 Azure F0 的 key 与 region

## Spike 6: 中文 .doc 解析

- **结论**：✅ **部分 GO** —— 选定 `catdoc`，但**必须做基于内容的失败检测**，退出码不可信

### 工具对比（样本由 LibreOffice 生成，见下方局限说明）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `antiword` | ❌ 崩溃："text stream of this file is too small to handle" | 1 |
| `antiword -m UTF-8.txt` | ❌ 同上 | 1 |
| **`catdoc`** | ✅ **中文完全正确** | 0 |
| `catdoc -d utf-8` | ✅ 正确 | 0 |

设计文档第 5 节预判「antiword 对中日韩支持弱、catdoc 更可能成功」——**实测坐实**。而且 antiword 是直接崩溃，不是吐乱码，属于「好的失败」。

**选定方案：`catdoc`。antiword 出局。**

### ⚠️ 关键发现：catdoc 会静默失败

```
$ catdoc /tmp/fake.doc          # 喂一个根本不是 .doc 的纯文本文件
è¿™ä¸æ˜¯ä¸€ä¸ªçœŸæ£çš„ doc æ–‡ä»¶     # ← 吐出乱码
退出码：0                        # ← 却报告成功
```

**退出码完全不能用来判断成败。** 这正是设计文档第 5 节担心的失败模式：乱码悄悄流进配音环节，比直接报错糟糕得多——用户会拿到一条念着乱码的视频。

**因此 `importers/` 必须做基于内容的校验**，建议规则：抽取结果中若 CJK 码点占比过低、而 Latin-1 补充区（`À`–`ÿ`）字符占比异常高，判定为乱码并拒绝，提示用户另存为 `.docx`。**不能只看退出码。**

### 本次验证的局限（必须诚实记录）

**样本是 LibreOffice 生成的，无法代表真实世界的 Word 2003 文件。**

- LibreOffice 写出的 `.doc` 头部**永远标 code page 65001（UTF-8）**，而真实的中文 Word 2003 文档通常是 **cp936（GBK）**
- 尝试构造 GBK 样本失败：LibreOffice 会写出「头标 65001、内容却是 GBK 字节」的自相矛盾文件，测出来的乱码是造样本工具的锅，不是 catdoc 的锅——**该测试无效，未采信**
- 另外测得：**catdoc 忽略 `-s` 参数**，只认文档头声明的 code page（`-s cp936` 与 `-s cp1252` 输出完全相同）

**所以「真实 cp936 中文 .doc 能否被 catdoc 正确解析」这一点仍未验证。** 这不影响架构（`.doc` 本来就是「尽力而为」的降级路径），但**拿到真实样本后应当复验**。基于内容的校验规则正是为这种不确定性兜底的——读不出来就明确拒绝，绝不假装成功。
