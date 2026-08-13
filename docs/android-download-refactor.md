# 安卓下载状态机重构 —— 详细方案

**上级文档**:`docs/download-fix-plan-v2.md` 第 4 节(这里是它的展开)
**问题清单**:`docs/code-review-2026-08-13.md` #1/#2/#3/#4/#5/#6/#7/#8/#9/#12/#14

---

## 1. 现在为什么会坏

一条下载的状态散在**六个地方**,没有单一真相来源:

```java
STATE          Map<String,Snapshot>   静态内存，key = System.currentTimeMillis()
SharedPrefs    "state_v1"             磁盘，格式 id|status|done|total|title|url
ACTIVE         Map<String,Boolean>    按【文件名】去重
PAUSED         Map<String,Boolean>
CANCELLED      Map<String,Boolean>
downloadIds    List<Long>             老的系统下载器遗留，已废弃
```

**身份是时间戳** —— 每次点下载都是一个新 id。于是:

| 现象 | 机制 |
|---|---|
| 删了会复活(#2) | 删除只清 `STATE`,磁盘那行没动;下次 `restore()` 又读回来 |
| 每杀一次进程攒一条幽灵(#8) | REDELIVER 用新 id 重投 + restore 复活旧 id = 同一条片子两条记录 |
| 抹掉其他下载的记录(#7) | `persist()` 拿内存整体覆写磁盘;服务在无 Activity 的进程被拉起时内存是空的 |
| 失败伪装成已暂停(#9) | `restore()` 无视磁盘上的 status,一律标 paused;`error` 根本没落盘 |
| 暂停占死线程(#1) | 暂停在 worker 线程里 `while(sleep)` 死等,单线程池被堵死,锁整夜不放 |
| 服务永不退出(#6) | 空闲判定看 status 字符串,而 restore 出来的记录恒为 paused 且没有线程 |

**结论:不是六个 bug,是一个设计缺失的六种表现。**

---

## 2. 目标设计

### 2.1 单一真相 = 磁盘,身份 = projectId

```java
final class DownloadRecord {
    final String projectId;   // ← 身份。稳定、唯一、和服务端对得上
    String title;             // 显示用
    String url;               // 可由 projectId 推导，存着省一次拼接
    String cookie;            // 通知栏点「继续」时 Activity 可能不在
    long total;               // -1 = 还不知道
    long done;
    Status status;
    String error;             // FAILED 时必须有，且必须落盘
    long updatedAt;
}

enum Status { RUNNING, RECONNECTING, PAUSED, DONE, FAILED }
```

**`DownloadStore` —— 唯一的读写入口,每次操作都读盘再写盘:**

```java
static synchronized List<DownloadRecord> all()
static synchronized DownloadRecord get(String projectId)
static synchronized void upsert(DownloadRecord r)   // 读盘 → 替换这一条 → 写回
static synchronized void remove(String projectId)   // 读盘 → 删这一条 → 写回
```

> ⚠️ **`upsert`/`remove` 必须"读盘 → 改一条 → 写回",不能拿内存整体覆写。**
> 这一条直接消灭 #7:即使服务在没有 Activity 的进程里被拉起、内存里什么都没有,
> 它也只会改自己那一条,碰不到别人的。

**序列化改用 `org.json`**(安卓平台自带),不再手写 `esc/unesc` —— 顺带修掉 #12
(标题含字面量 `\p` 时往返损坏)。

### 2.2 三个 Set 全部并进 `status`

| 原来 | 现在 |
|---|---|
| `ACTIVE`(按文件名去重) | key 是 projectId → **天然去重**,不需要这个 Set |
| `PAUSED` | `status == PAUSED` |
| `CANCELLED` | 记录被 `remove()` 掉;worker 每轮检查"我这条还在不在" |
| `downloadIds`(系统下载器遗留) | **整个删掉** —— 那条路一次都没工作过 |

### 2.3 worker 注册表:生命周期的唯一依据

```java
static final Map<String, Future<?>> WORKERS   // projectId -> 正在跑的任务
```

- **是否空闲** = `WORKERS` 里还有没有活着的 → 修 #6(不再看 status 字符串)
- **是否重复** = `WORKERS.containsKey(projectId)` → 修 #8
- 线程池仍然**单线程**(带宽有限,并发只会互相抢),但**暂停不再占线程**,队列不会被堵死

---

## 3. 状态转换

```
                    点下载 / 点继续
                          ↓
                    ┌─ RUNNING ─┐
      网络错误 ──────┤           ├────── 传完 ──→ DONE（删记录、删 .part）
                    ↓           │
              RECONNECTING      ├── 用户暂停 ──→ PAUSED
                    │           │              （线程退出、锁释放、
              退避后 ┘           │                通知转成「继续」）
                                │
                                └── 致命错误 ──→ FAILED（带原因，落盘）
       连续 20 次零进展 ──────────────────────→ FAILED
```

### 3.1 暂停(修 #1)

**现在**:worker 线程里 `while (PAUSED) sleep(500)` —— 占死单线程池,
后面排队的下载一个字节都传不了;`PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF`
整个暂停期间一直持有(**暂停过夜 = 整夜空耗电**)。

**改成**:

```
收到暂停 → 置 worker 的 volatile pauseRequested
         → worker 读到之后：跳出读循环 → 释放两把锁 → status=PAUSED 落盘
         → 从 WORKERS 摘掉自己 → 线程结束
```

**线程退出 = 锁必然释放**(在 finally 里),不需要额外的生命周期管理。

### 3.2 继续(修 #14)

今天她点了没反应,是因为 `s.url == null` 时那段逻辑**静默什么都不做**。

```
点「继续」
  ↓
WORKERS 里有这条吗？
  ├─ 有 → 清 pauseRequested，worker 自己继续
  └─ 无 → 起一个新 worker
            ├─ url 取不到 → 用 projectId 现推：BASE_URL/api/projects/<id>/film/download
            ├─ cookie 有效 → 从 .part 断点接着传
            └─ 401/403    → FAILED「登录过期，请重新打开 App」
```

**铁律:每一条路径要么开始传,要么写下明确的失败原因。不允许"什么都不发生"。**

### 3.3 重试分类(修 #3、#5)

**现在**:HTTP 状态码被塞进异常消息(`"续传被拒：HTTP " + code`),再用
`contains("续传被拒")` 判致命 —— 于是**下到 300MB 时遇上一次 503,直接放弃**;
而同样的 503 发生在从零开始时反而无限重试。**方向完全反了。**

**改成:状态码单独传递,显式分类:**

| 情况 | 判定 | 处理 |
|---|---|---|
| 200 / 206 | 正常 | 继续传 |
| **416** | Range 无效(`.part` 比服务端文件还长) | **删 `.part` 从 0 重来**,不是失败 |
| **401 / 403** | 登录过期 | FATAL「请重新打开 App」 |
| **404 / 410** | 成片已被清理 | FATAL「请重新点一次下载」 |
| **5xx / 408 / 429** | 服务端临时问题 | **可重连** |
| IOException 含 `ENOSPC` | 手机存储满 | FATAL「手机空间不足」 |
| 其他 IOException | 网络抖动 | **可重连** |

**重连次数:不封顶,但要求有进展。**

```
每次尝试传了 >0 字节  → consecutiveZeroProgress = 0
每次尝试传了  0 字节  → consecutiveZeroProgress++
连续 20 次零进展      → FAILED
```

这样既满足"只要还在往前爬就一直重连",又不会像现在这样
**磁盘满时永远卡在「断线了,正在自动重连」**(#5)。

### 3.4 通知(修 #4)

**现在**:完成通知拆到 4201 之后,**没有任何代码取消 4200**,而
`STOP_FOREGROUND_DETACH` 明确保留它 → 每下完一条就多一条**划不掉的僵尸**。

**改成:一条进度通知 `FG_NOTIFY_ID`,随状态改写,终态明确取消:**

| 状态 | 通知 |
|---|---|
| RUNNING | ongoing + 进度条 + 速度 + 「暂停」 |
| RECONNECTING | ongoing + 「断线了,正在自动重连」+ 「暂停」 |
| PAUSED | **非 ongoing**(可划掉)+ 「已暂停」+ 「继续」← 切出 App 后唯一的恢复入口 |
| DONE / FAILED | **`nm.cancel(FG_NOTIFY_ID)`**,另发一条 `DONE_NOTIFY_ID` |

服务停止时 `stopForeground(STOP_FOREGROUND_REMOVE)`。

### 3.5 空闲判定(修 #6)

```java
boolean busy = WORKERS.values().stream().anyMatch(f -> !f.isDone());
```

**只看有没有活着的线程**,不看任何状态字符串。
PAUSED 的记录不再让服务永久驻留 —— 它没有线程,服务就该退出;
用户点继续时服务会被重新拉起。

---

## 4. 迁移(老数据怎么办)

老记录的 key 是时间戳,新的是 projectId。**能自动迁移**:

```
老记录的 url = https://.../api/projects/<projectId>/film/download
             → 用正则把 projectId 抠出来 → 建新记录
```

- 抠不出 projectId 的老记录 → 丢弃(`.part` 还在,重新点下载会接上)
- `.part` 文件名从 `<标题>.part` 改成 `<projectId>.part`
  → 迁移时**如果老名字的文件存在就 rename**,不丢进度
- 老的 `downloadIds`(系统下载器遗留)整个删掉

**迁移只跑一次**,用 `state_v2` 作为新 key,读到老的 `state_v1` 就转换并删除。

---

## 5. 分两步走(**建议**)

### 第一步:存储层(修 #2 / #7 / #8 / #9 / #12)

只做"磁盘为唯一真相 + key 换 projectId",**不碰线程模型**:

1. 新建 `DownloadStore`(org.json 序列化,读盘-改一条-写回)
2. `Snapshot` → `DownloadRecord`,key 换 projectId
3. 删掉 `ACTIVE` / `downloadIds`,`CANCELLED` 改成"记录还在不在"
4. `restore()` 如实恢复 status 和 error(FAILED 仍是 FAILED)
5. 迁移老数据
6. `Bridge` 三个方法改用 projectId

**为什么先做这一步**:它是纯数据层改动,**行为不变、风险最低**,而且
后面线程模型的改动全都建立在"有一个可靠的状态存储"之上。

**验证**:装包 → 下一半 → 强杀 App → 重开 →
下载栏有记录、状态和进度都对 → 删除它 → 重启 App → **不再复活**。

### 第二步:线程与重试(修 #1 / #3 / #5 / #6 / #14)

1. `WORKERS` 注册表,空闲判定改成看线程
2. 暂停改成线程退出 + 锁释放
3. 继续改成重新入队,且**任何路径都有确定结果**
4. HTTP 状态码显式分类,416 重来 / 4xx 致命 / 5xx 重连 / ENOSPC 致命
5. 连续零进展计数
6. 通知按状态改写,终态 cancel

**验证**:
- 暂停 A → 下 B → **B 能正常传**(现在会被 A 堵死)
- 暂停一夜 → 电量正常(锁已释放)
- 断网 10 分钟再恢复 → 自己接上,不用手动点
- 把手机存储填满 → **明确报「空间不足」**,而不是永远「重连中」

### 为什么建议分两步

线程模型是最容易藏 bug 的地方(死锁、竞态、锁泄漏),而**存储层可以独立验证**。
先把地基打稳,第二步出问题时也能确定"至少状态是对的"。

代价是**多发一次版**(2.8.0 和 2.8.1)。考虑到今天一天已经发了 5 个版本、
每次都在救火,我认为**稳比快重要**。

---

## 6. 不改什么(避免过度设计)

| 保持现状 | 理由 |
|---|---|
| 单线程池 | 带宽就那么点,并发只会互相抢。暂停不占线程之后,单线程不再是瓶颈 |
| 前台服务 + 唤醒锁 | 机制本身是对的,问题只在"暂停时不该继续持有" |
| `.part` + Range 续传 | 今天验证过是有效的(从 55MB 一口气续到 458MB) |
| SharedPreferences | 记录数是个位数,上不了 Room 那种量级 |
