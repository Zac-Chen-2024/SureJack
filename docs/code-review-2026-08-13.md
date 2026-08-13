# 下载链路 Code Review —— 2026-08-13

审查对象:`ba526d2`(下载进度落盘 / 暂停继续 / 无限重连那一批改动)。
高强度模式,8 个独立视角并行找问题,约 30 个原始候选去重后逐条校验。

**一行代码都没有改动。** 这份文档只记录问题,修不修、什么时候修由人定。

> **背景**:这些问题几乎全部集中在 2026-08-13 当天为了救"下载一直失败"
> 而连夜写的安卓下载器里。那天从「系统 DownloadManager 一次都没工作过」
> 一路改到「自己实现带断点续传的前台服务」,连发了 5 个版本
> (2.6.0 → 2.7.1)。**改得急,坑就多**——这份清单是那一夜的账。

---

## 🔴 P0:会让下载彻底不可用

### 1. 暂停会把唯一的下载线程占死

`android/.../DownloadService.java:385` · **CONFIRMED**

线程池是 `Executors.newSingleThreadExecutor()`(第 221 行),而"暂停"的实现是
在**工作线程里**死等:

```java
while (Boolean.TRUE.equals(PAUSED.get(id)) && !CANCELLED...) {
    Thread.sleep(500);
}
```

于是暂停 A 之后再下 B,**B 永远排在 A 后面,一个字节都传不了**。
更糟的是 B 的 `Snapshot` 状态显示 `running`、`startForeground` 还会把 A 那条
带「继续」按钮的通知覆盖掉——**用户既下不了 B,也找不到恢复 A 的入口**。

同时 `PARTIAL_WAKE_LOCK`(6 小时)和无超时的 `WIFI_MODE_FULL_HIGH_PERF`
在整个暂停期间一直被持有(锁在 `download()` 的 finally 才释放,366–367 行)。
**暂停过夜 = CPU/WiFi 高性能锁整夜空耗电**,和代码注释里写的"绝不泄漏"正相反。

> 修法方向:暂停应该让任务**退出线程**、把状态落盘,而不是占着线程空转;
> 恢复时重新入队。锁必须随着线程退出一起释放。

### 2. 删掉的下载会自己复活

`android/.../MainActivity.java:441` · **CONFIRMED**

`persist()` 只在 5 个地方调用(242 / 284 / 468 / 483 / 595),
**取消和删除这条链路上一次都没有**。`removeDownload` 只做内存里的
`STATE.remove`,SharedPreferences 里那一行原封不动。

结果:**每次重启 App,被删掉的下载都以「已暂停」+「继续」按钮复活**,
删几次回来几次。对于"从磁盘恢复出来、背后根本没有线程"的记录,
删除**永远无效**。

### 3. isFatal 的方向反了 —— 越接近下完越容易前功尽弃

`android/.../DownloadService.java:427` · **CONFIRMED**

带 `Range` 的请求收到任何非 206/200 的响应(**包括瞬时的 502/503**)都会抛
`续传被拒:HTTP xxx`,而 `isFatal()` 用子串匹配把"续传被拒"判成**永久失败**。

```
458MB 下到 300MB → 断线重连时 nginx 恰好在 reload → 503
  → 抛「续传被拒:HTTP 503」→ isFatal 命中 → 立刻放弃
```

**300MB 白费。** 而同样一个 503,如果发生在"从零开始"的请求上,反而会被
当成网络抖动无限重试。

改之前这里最多重试 30 次;这次"无限重连"的改动,**把最需要保护的场景的
重试次数变成了 0**。

---

## 🟠 P1:资源泄漏 / 状态错乱

### 4. 每次下载结束都留下一条划不掉的僵尸通知

`android/.../DownloadService.java:339` · **CONFIRMED**

完成/失败通知拆到 `DONE_NOTIFY_ID`(4201)之后,**全文件再没有任何一处
更新或取消 `FG_NOTIFY_ID`(4200)**,而 `stopSelfIfIdle` 用的
`STOP_FOREGROUND_DETACH` 明确要求保留它。

于是每下完一条,通知栏就多一条:停在最后一次进度、`setOngoing(true)`
**划不掉**、带一个指向已结束 id 的「暂停」按钮,直到强停 App。

这是这次拆通知 ID 引入的**回归**——改之前完成通知复用同一个 id,
会顶掉进度卡(那是另一个 bug,见当天的提交记录),但至少不留僵尸。

### 5. 磁盘满 = 永远"重连中",永不报错

`android/.../DownloadService.java:379` · **CONFIRMED**

去掉 `MAX_RETRY` 之后,`for(;;)` 对**持久性错误**也无限重连:

```
手机存储写满 → out.write 抛 IOException("No space left on device")
  → isFatal 不匹配 → reconnecting → 退避 60s → 再写再失败 → 无限循环
```

用户对着一个**永远的「断线了,正在自动重连」**,WiFi 高性能锁持续持有、
前台服务永不退出(`reconnecting` 也算 busy)。改之前 30 次后会明确报错。

### 6. 恢复出来的僵尸记录让服务永不退出

`android/.../DownloadService.java:334` · **CONFIRMED**

`stopSelfIfIdle` 拿 status 字符串当"有活干"的依据,而 `restore()` 造出来的
记录 status **恒为 `paused` 且背后没有任何线程**。

只要存在一条未处理的恢复记录,服务把所有真实下载做完之后也**永远不会
stopSelf / 撤前台**——常驻通知 + 进程常驻内存耗电,直到用户把每一条僵尸
都恢复或删除(而删除又因为第 2 条 bug 删不掉)。

### 7. 服务被系统重启时会抹掉其他下载的记录

`android/.../DownloadService.java:161` · **PLAUSIBLE**

`persist()` 用内存里的 `STATE` **整体覆写** `KEY_STATE`,而 `restore()`
只在 `MainActivity.onCreate`(182 行)里调用过。

当服务在**没有 Activity 的进程**里被 `START_REDELIVER_INTENT` 拉起时,
`STATE` 是空的 → 第一次 `persist()` 就把其他未完成下载的续传记录**永久抹掉**:

```
已暂停的 B 已落盘 + 正在下的 A
  → vivo 杀进程 → 系统只重启 Service、重投 A 的 Intent
  → STATE 里只有 A → persist 覆写 → B 的 id/url/进度消失
  → 用户打开 App,B 从下载栏彻底不见（.part 还在盘上）
```

**这正是本次提交要修的「下载栏空白」在另一条路径上原样复现。**

> 修法方向:`Service.onCreate` 里也先 `restore()` 再 `persist()`。

### 8. 杀一次进程,多攒一条幽灵记录

`android/.../DownloadService.java:186` · **PLAUSIBLE**

持久化和恢复只按 id 去重,而**每次 `ACTION_START` 都造一个新的时间戳 id**。
进程被杀之后:REDELIVER 用新 id 重投 + `restore()` 复活旧 id
= **同一条片子在面板上出现两条**。

对着那条幽灵点「继续」时,249 行的 `ACTIVE` 已经含有同名文件 →
只把 status 改成 `running`、**既不启线程也不清记录** → 幽灵永远停在某个百分比、
没有速度,每次 persist 都被重写、每次重启都回来,并且让第 6 条的
`stopSelfIfIdle` 永远 busy。**每杀一次进程多攒一条。**

> 2026-08-13 17:37 线上实测到的正是这个:一个带老 UA(`SureJackApp/9`)的
> 幽灵任务和用户手动新点的任务(`/14`)在同一台手机上轮流抢同一条
> 几十 KB/s 的管子。客户端删不掉,最后是在**服务端按老 UA 回 403**
> 才把它掐死的(见 `src/queue/routes.ts` 里那段标了【临时】的代码)。

### 9. 致命失败重启后伪装成"已暂停"

`android/.../DownloadService.java:189` · **CONFIRMED**

`persist()` 会写入 `status=error` 的行(只跳过 `done`),而 `restore()`
**无视持久化的状态字段,一律标成 `paused`**,并且失败原因 `s.error`
根本不落盘。

```
成片被服务端清理 → 404 → fail() 标 error 并落盘
  → 重启 App → restore() 变成「已暂停」+「继续」
  → 点继续 → 再 404 → 再失败 → 再落盘 → 永动僵尸
```

"登录过期 / 文件没了"的解释在重启后**不复存在**,用户只能反复撞同一堵墙。

---

## 🟡 P2:界面 / 规范

### 10. 悬浮下载角标压住了成片页的「下载视频」按钮

`web/src/pages/MobileWorkspace.tsx:217` · **CONFIRMED**

悬浮版 `DownloadPanel`(`fixed right-3`、safe-area+10、`z-40`、`size-9`)
和成片页/预览页右上角的「下载视频」按钮(`right-4`、同一 top、`z-20`、`size-10`)
**几乎完全重叠**,而且它**只在忙的时候才出现**。

```
第 1 集在下 → 用户进第 2 集成片页点「下载视频」
  → 36×36 的悬浮按钮以 z-40 盖住约 32×36px → 点击变成开关下载队列弹层
第 1 集下完的瞬间 → 悬浮按钮卸载 → 同一位置又变回下载按钮
```

**同一个坐标的点击目标在一次会话里来回换身份**,误触就是又起一条流。

### 11. 播放/暂停用了文本字符,违反项目规矩

`web/src/components/mobile/DownloadPanel.tsx:269`

`▶` / `⏸` 是文本字形,而项目的硬性规矩是**图标一律用 SVG(`Icon.tsx`)**。
`IconPlay` / `IconPause` 在 `web/src/components/ui/Icon.tsx`(258 / 327 行)
**已经存在**,而且这个文件本来就在从那儿导入图标——一行就能改完。

### 12. 其他

| 位置 | 问题 |
|---|---|
| `DownloadService.java` `esc/unesc` | 标题或 URL 里含字面量 `\p` 时往返会损坏(`unesc` 先替换 `\p` 再折叠 `\\`)。机制 CONFIRMED,输入罕见。建议直接复用已有的 `jsonStr()` |
| `DownloadService.java:399` | 外层取消路径仍把取消标成"已暂停",而 447 行已改名为"已取消"。PLAUSIBLE,窄竞态 |
| `DownloadService.java` persist / 通知 | 每秒重建一次通知渠道和 PendingIntent,连续几小时。效率问题,非正确性 |
| 通知栏「继续」 | 恢复一条 restore 出来的记录时转发的 cookie 为 null → 401/403 直接致命失败。PLAUSIBLE,罕见路径 |

---

## 建议的修复顺序

1. **第 1 条**(暂停占死线程)—— 它同时制造"下载卡住"和"整夜耗电"两个后果
2. **第 3 条**(isFatal 方向反了)—— 越接近下完越容易前功尽弃,损失最大
3. **第 2 + 9 条**(删除会复活 / 失败伪装成已暂停)—— 同一个根因:取消和错误状态没有正确落盘
4. **第 4 + 6 条**(僵尸通知 / 服务不退出)—— 同一个根因:生命周期靠状态字符串判断
5. **第 7 + 8 条**(进程重启丢记录 / 攒幽灵)—— 需要一起改,id 应该按**项目**而不是时间戳来定
6. **第 10 条**(按钮重叠)—— 一行 CSS
7. 其余按需

---

## 补充:2026-08-13 当天实测中新暴露的两条

### 13. 开机清扫会误删【正在下载】的成片

`src/server.ts:290` · **CONFIRMED（线上真实发生）**

开机清扫调用 `sweepDelivered(assetRoots())`(不设时限),注释写着
"开机时一定没有正在进行的下载,删了不会误伤"。

**这句话在"主动重启服务去改配置"时是错的。** 18:12 为了让 BBR 立刻生效
重启了一次,清扫当场把用户正在下载的那份 480MB 成片删掉了
(日志:`开机清扫：上次遗留的下载临时文件 {清掉: 1}`),用户那一侧表现为
"点继续没反应"。

根因是成片文件名用随机串,不携带任何身份信息——重启后无法分辨
"有用的"和"垃圾",于是只能一律删。修法见 `docs/download-fix-plan.md` 第 2 节。

### 14. 「继续」在 url 为空时静默失败

`DownloadService.java` `ACTION_RESUME` 分支 · **CONFIRMED（线上真实发生）**

`if (!pause && !ACTIVE.containsKey(...) && s.url != null)` —— 条件不成立时
**既不启线程也不报错**。用户点了「继续」,6 分钟内服务端没有收到任何
`/film/download` 请求,而 App 一直在正常轮询(说明进程活着,就是这个按钮没反应)。

**任何一条路径都不该是"什么都不发生"。** 修法见方案第 3 节末尾。

---

## 附:临时代码待清理

~~`src/queue/routes.ts` 里有一段标了【临时】的 UA 拦截~~ ✅ **已删除**
(幽灵任务在 17:56 吃到 403 后永久停止,之后再没出现过)。
