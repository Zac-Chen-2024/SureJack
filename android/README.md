# SureJack 安卓 APK（TWA）

SureJack 是**依赖服务器**的应用（配音、素材、合成都在后端），没法离线跑，
所以安卓端用 **TWA（Trusted Web Activity）**——一层薄壳，全屏打开线上的
PWA `https://surejack.zacchen.win/`。壳里没有业务逻辑，网页更新即 App 更新，
不必重新发包。

## 身份（改了就变成另一个 App，装机后不可改）

| 项 | 值 |
|---|---|
| App 名 | SureJack |
| packageId | `win.zacchen.surejack` |
| 签名 SHA-256 | `9B:45:D4:05:AB:FF:0A:3F:78:20:CF:4E:8A:D6:3A:D6:6D:07:F8:79:6D:BD:B0:D4:EA:6A:1D:53:CC:1B:37:6E` |

## 签名密钥 ⚠️

- 密钥文件 `android.keystore`、密码写在仓库根 `android-signing-secret.txt`
  ——**两者都不入库**（`.gitignore` 挡掉了）。
- **务必离线备份**：丢了这个 keystore，就再也无法给同一个 App 发更新
  （只能换 packageId 重新发一个，等于换 App）。

## 全屏（Digital Asset Links）

APK 默认会带一条顶部地址栏（Custom Tab 样式）。要真正全屏，需要域名侧
证明它授权了这个签名——即 `config/assetlinks.json`，由后端路由
`GET /.well-known/assetlinks.json` 对外提供（见 `src/server.ts`）。
里面的指纹就是上面的 SHA-256。**部署上线后**该文件生效，重装/重开 App
即全屏。

## 重新构建（换图标、升版本号等）

前提：JDK 17 + Android SDK(build-tools;34.0.0, platforms;android-34) +
`@bubblewrap/cli`；`~/.bubblewrap/config.json` 指向 jdk / sdk。
把本目录的 `twa-manifest.json` 和 `android.keystore` 放进一个工作目录，
升 `appVersionCode` 后：

```bash
BUBBLEWRAP_KEYSTORE_PASSWORD=... BUBBLEWRAP_KEY_PASSWORD=... \
  bubblewrap build --skipPwaValidation
```

产物 `app-release-signed.apk`（侧载用）、`app-release-bundle.aab`（上架
Google Play 用）。首次构建若提示缺 `manifest-checksum.txt`，用
`sha1(twa-manifest.json)` 写一个即可跳过交互。

## App 内自检更新（发版流程）

壳会把自己的 versionCode 通过 `?appVersion=N` 带给网页（见本目录的自定义
`LauncherActivity.java`），网页比对 `/api/app-version`（内容来自
`config/app-version.json`）决定是否提示更新。所以**每次发版**要三件一致：

1. `twa-manifest.json` 的 `appVersionCode`（+`appVersionName`）↑。
2. 生成项目后，用本目录的 `LauncherActivity.java` **覆盖**生成的那个
   （AGP 8 不生成 BuildConfig，所以版本号走 PackageManager 读，不用改 gradle）。
3. 构建、把 APK 传到 GitHub release，**资产名必须是 `SureJack.apk`**
   （`config/app-version.json` 的 apkUrl 指向 `releases/latest/download/SureJack.apk`）。
4. 把 `config/app-version.json` 的 `versionCode/versionName` 改成这次的值并部署。

⚠️ 安卓侧载无法静默安装，"更新"= 打开下载链接、系统弹窗点确认。真·静默
自动更新只有上 Google Play 才有。
