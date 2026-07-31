# screenshots/ —— 手机版界面截图

都是拿【线上那份构建产物】在手机尺寸（412×915，2.5x，触摸模式）下跑出来的真实渲染，
不是设计稿。所有 `/api/` 请求在 Playwright 里被拦下来喂假数据，不碰真账号、真项目。

重跑：`node spikes/jassub/list-shot.mjs`（playwright 只装在 `spikes/jassub/node_modules`，
所以台子放在那儿；图落到这个目录。会覆盖同名文件）。

| 文件 | 拍的是什么 |
| --- | --- |
| `list.png` | 项目列表。缩略图是**真封面**（按宽度铺满、纵向居中裁切）；分隔带上下留白；「被取消的那条」显示**未完成** |
| `cover-repro.png` / `cover-diff.png` | 封面复刻 vs 参考图。差异图里红=参考多出、绿=复刻多出、白=重合——只剩边缘一像素 |
| `episode-1-cover.png` / `episode-2-cover.png` | 分集验收：主片和续集各自的封面第一帧 |
| `episode-reminder.png` | 续集第 88.6 秒——「分集验收第二集开始啦」念出来、有字幕，背景此时已经是地铁跑酷 |
| `lab-phone.png` / `lab-desktop.png` | 字幕尺子 `/subtitle-lab`：真实底图 + 真实字体的字幕，两个滑块 |
| `lab-submitted.png` | 提交后的回执「已严肃收集」 |
| `cover-titles.png` | 四种长度的标题：4 字（和参考同字号）、9 字（换两行）、7 字、14 字（换行 + 缩字号） |
| `downloads.png` | 下载队列悬浮框（进行中一条 + 已保存一条 + 底部说明） |
| `search-mid.png` | 放大镜拉开到一半的中间帧——用来看展开动画有没有真的在动 |
| `search.png` | 搜索胶囊展开后输入「老宅」，列表实时过滤 |
| `video-loading.png` | **视频流慢**：成片就绪但流迟迟不来，中间显示「视频加载中 xx%」+ 缓冲条 |
| `preview-slow.png` | **慢网络下点进已完成项目**：`/film` 故意永不返回，此时必须显示成片第一帧 + 右上角下载键，而不是「还没有成片」 |

改完界面记得重跑一遍看图，别只看代码——这个项目的界面问题基本都是肉眼才发现的。
