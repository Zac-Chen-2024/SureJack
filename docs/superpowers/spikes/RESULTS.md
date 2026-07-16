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

- **结论**：待验证

## Spike 4: 443 入站可达性

- **结论**：待验证

## Spike 5: Azure zh-CN 字级时间戳

- **结论**：阻塞中——等待用户提供 Azure F0 的 key 与 region

## Spike 6: 中文 .doc 解析

- **结论**：阻塞中——等待用户提供真实的中文 `.doc` 样本
