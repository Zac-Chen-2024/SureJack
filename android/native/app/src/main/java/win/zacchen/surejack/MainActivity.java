package win.zacchen.surejack;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.splashscreen.SplashScreen;

/**
 * SureJack 安卓宿主。
 *
 * ── 为什么从 TWA 换成原生 WebView ──────────────────────────────────────
 * TWA 的网页跑在 Chrome 自己的进程里，我们的 App 只是启动器，于是：
 *   1) 返回键归 Chrome 管，我们收不到 → 想在根页做"挽留"确认只能靠 History
 *      hack，而 TWA 的"没历史可退就结束 Activity"会先一步生效，真机上永远不弹。
 *   2) 原生启动图消失后 Chrome 才冷启动、再加载页面 → 中间那段空档没法消除。
 * 自己持有 WebView 之后这两件事都变成【我们的】：返回键在 onBackPressed 里，
 * 启动图可以一直保持到网页 onPageFinished 才交接。这才是安卓标准做法。
 *
 * ── WebView 必须显式接好的东西（不接就会坏）─────────────────────────
 *   · JS / DOM Storage / Cookie：会话与前端状态
 *   · onShowFileChooser：上传 txt / mp3 / srt
 *   · DownloadListener（带 Cookie）：下载成片（接口要登录态）
 *   · setMediaPlaybackRequiresUserGesture(false)：BGM 与视频的程序化同步播放
 */
public class MainActivity extends AppCompatActivity implements SensorEventListener {

    private static final String HOST = "surejack.zacchen.win";
    /** 后台任务要用同一个源去取 cookie、发请求 */
    static final String BASE_URL = "https://" + HOST;
    private static final int REQ_FILE = 1001;

    private WebView web;
    private boolean pageReady = false;
    private ValueCallback<Uri[]> fileCallback;

    /**
     * 发起过的下载 id，供 Bridge.downloads() 查询进度。
     *
     * ⚠️【必须落盘，不能只放内存】。系统 DownloadManager 本来就是后台下的：
     * 退出 app 照样下、通知栏有进度、断网自动重试。但这个列表只活在内存里的话，
     * app 一被回收、一重启，网页里的"下载队列"就变成空的——
     * 【文件还在后台好好地下，用户却看不见】，于是他以为没下上、再点一次，
     * 服务端又白混一份几百 MB 的成片。
     *
     * 存的是 id，不是进度。进度永远现查 DownloadManager——它才是唯一真相，
     * 我们缓存一份只会和它对不上。
     */
    private static final String PREFS_DOWNLOADS = "sj_downloads";
    private static final String KEY_IDS = "ids";
    private final java.util.List<Long> downloadIds = new java.util.ArrayList<>();

    /** 从盘上读回下载 id。开机（onCreate）调一次 */
    private void loadDownloadIds() {
        SharedPreferences sp = getSharedPreferences(PREFS_DOWNLOADS, Context.MODE_PRIVATE);
        String raw = sp.getString(KEY_IDS, "");
        synchronized (downloadIds) {
            downloadIds.clear();
            for (String part : raw.split(",")) {
                if (part.isEmpty()) continue;
                try { downloadIds.add(Long.parseLong(part)); } catch (Exception ignored) { }
            }
        }
    }

    /** 把当前列表写回盘上。加/删之后都要调 */
    private void saveDownloadIds() {
        StringBuilder b = new StringBuilder();
        synchronized (downloadIds) {
            for (Long id : downloadIds) {
                if (b.length() > 0) b.append(',');
                b.append(id);
            }
        }
        getSharedPreferences(PREFS_DOWNLOADS, Context.MODE_PRIVATE)
                .edit().putString(KEY_IDS, b.toString()).apply();
    }

    /**
     * 摘掉 DownloadManager 里【已经不存在】的 id。
     *
     * 用户在系统下载管理里手动删过、或者系统自己清理过之后，这些 id 会永远
     * 查不到东西。不摘的话列表只增不减，越攒越长。
     */
    private void pruneDownloadIds() {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        long[] ids;
        synchronized (downloadIds) {
            ids = new long[downloadIds.size()];
            for (int i = 0; i < ids.length; i++) ids[i] = downloadIds.get(i);
        }
        if (ids.length == 0) return;
        java.util.Set<Long> alive = new java.util.HashSet<>();
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(ids))) {
            while (c != null && c.moveToNext()) {
                alive.add(c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)));
            }
        } catch (Exception ignored) { return; }
        boolean changed;
        synchronized (downloadIds) { changed = downloadIds.retainAll(alive); }
        if (changed) saveDownloadIds();
    }
    private SensorManager sensors;
    private long lastShakeAt = 0;
    private float lastX, lastY, lastZ;
    private long lastSampleAt = 0;
    private boolean primed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 启动图：一直保持，直到网页真的加载完（消灭"启动图没了但页面还没来"的空档）
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !pageReady);
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(0xFF161A1E);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // 允许程序化播放（BGM 同步）
        s.setUserAgentString(s.getUserAgentString() + " SureJackApp/" + versionCode());
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        // 下载队列桥：网页调 SJNative.downloads() 拿进度画悬浮框
        web.addJavascriptInterface(new Bridge(), "SJNative");

        /*
         * 【把上次的下载接回来】。DownloadManager 在 app 不在的时候照样下，
         * 读回 id 才能让网页继续显示进度——否则用户回来看到空队列，
         * 以为下载没了。顺手摘掉系统里已经没有的那些，免得列表只增不减。
         */
        loadDownloadIds();
        pruneDownloadIds();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost();
                // 站内留在 App；站外（如 GitHub 上的 APK 更新包）交给系统处理
                if (host != null && host.endsWith(HOST)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                pageReady = true;   // 交接：启动图这才淡出
                // 登录态刚可能变化，落盘一次（见 onPause 上的说明）
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, android.webkit.WebResourceError err) {
                // 首屏失败也要放掉启动图，否则卡在启动图上什么都看不见
                if (req.isForMainFrame()) pageReady = true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // 下载成片：带上登录 Cookie，交给系统下载器落到"下载"目录
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                /*
                 * ⚠️【交给我们自己的 DownloadService，不再用系统 DownloadManager】。
                 *
                 * 系统那条路【一次都没成功过】：服务器上从 7 月 30 日至今的全部
                 * nginx 日志里，`AndroidDownloadManager` 这个 UA 出现 0 次，
                 * 横跨 App 版本 7 和 9、横跨两台手机。每一条下载请求都来自
                 * WebView 自己（UA 里带 wv），而 WebView 不会断点续传——
                 * 480MB 的成片在移动网络上传几 MB 就断，下次又从零开始。
                 *
                 * 日志还指出了交接断在哪：那些请求是 499（客户端自己断开）+
                 * 传输【0 字节】，正是 WebView 把下载交出去的动作；但系统下载器
                 * 那条请求从来没有到达服务器。dm.enqueue() 抛的异常被下面这个
                 * catch 吞掉，只弹一句"下载失败"，于是这件事安静地坏了很久。
                 *
                 * 现在自己下：我们控制续传和重试，失败原因还会报回服务端。
                 */
                try {
                    String name = fileNameFrom(contentDisposition, url, mimeType);
                    Intent i = new Intent(MainActivity.this, DownloadService.class);
                    i.setAction(DownloadService.ACTION_START);
                    i.putExtra(DownloadService.EXTRA_URL, url);
                    i.putExtra(DownloadService.EXTRA_NAME, name);
                    i.putExtra(DownloadService.EXTRA_COOKIE,
                            CookieManager.getInstance().getCookie(url));
                    i.putExtra(DownloadService.EXTRA_UA, userAgent);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
                    else startService(i);
                    Toast.makeText(MainActivity.this, "开始下载：" + name, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    // 失败要说清是什么失败——上一版就是被一句"下载失败"瞒过去的
                    Toast.makeText(MainActivity.this, "下载启动失败：" + e, Toast.LENGTH_LONG).show();
                }
            }
        });

        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);

        /*
         * 应用内更新：启动就问一次 /api/app-version，有新版就提示 → App 内下载
         * → 唤起安装。用户不用再去 GitHub 下包。失败静默（见 Updater）。
         */
        new Updater(this, HOST).checkInBackground();

        /*
         * 排上"片子做完了"的周期通知。
         * Android 13+ 要用户点头才能发通知——在这儿要一次，用户拒了也不影响别的。
         */
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                   != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ android.Manifest.permission.POST_NOTIFICATIONS }, 1001);
        }
        NotifyWorker.schedule(this);

        if (savedInstanceState == null) {
            // nativeUpdater=1：网页据此隐藏自己的更新横幅（原生已经接管了）
            web.loadUrl("https://" + HOST + "/?appVersion=" + versionCode() + "&nativeUpdater=1");
        } else {
            web.restoreState(savedInstanceState);
            pageReady = true;
        }
    }

    /**
     * 从 Content-Disposition 解析文件名。
     *
     * 【为什么不能只用 URLUtil.guessFileName】：后端发的是 RFC 5987 的
     * `filename*=UTF-8''%E8%B1%AA%E9%97%A8.mp4`（中文项目名必须这么发），
     * 而 guessFileName 不认这种扩展形式 → 退化成 URL 路径里的名字，
     * 于是下载下来的文件叫 "download" 而不是项目名。这里自己解一遍。
     */
    static String fileNameFrom(String contentDisposition, String url, String mimeType) {
        if (contentDisposition != null) {
            try {
                // 优先 filename*=charset''pct-encoded（带中文时后端用这个）
                Matcher m = Pattern.compile("filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)",
                        Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
                if (m.find()) {
                    String cs = m.group(1).trim();
                    String v = URLDecoder.decode(m.group(2).trim(),
                            cs.isEmpty() ? "UTF-8" : cs);
                    if (!v.isEmpty()) return v;
                }
                // 退一步：普通 filename="..."
                m = Pattern.compile("filename\\s*=\\s*\"?([^\";]+)\"?",
                        Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
                if (m.find()) {
                    String v = m.group(1).trim();
                    if (!v.isEmpty()) return v;
                }
            } catch (Exception ignored) { }
        }
        return URLUtil.guessFileName(url, contentDisposition, mimeType);
    }

    /**
     * 给网页用的下载桥：查询进度 + 中断/删除。
     *
     * downloads() 返回 [{id, title, total, done, status}]，网页据此画
     * "下载队列"悬浮框。系统通知栏本来也有进度，但用户要在 App 里看得见。
     */
    public class Bridge {
        /**
         * 网页主动弹一条通知。
         *
         * 【为什么 app 开着时也要弹】：后台那条周期任务最快 15 分钟才醒一次
         * （系统下限）。人就在 app 里等着的时候，等十几分钟才提示很蠢——
         * 前端一看到状态从"合成中"变"已完成"就调这里，立刻弹。
         */
        @JavascriptInterface
        public void notifyDone(String name, String projectId) {
            NotifyWorker.notifyDone(MainActivity.this, name == null ? "视频" : name,
                    projectId == null ? "" : projectId);
        }

        @JavascriptInterface
        public String downloads() {
            /*
             * 【我们自己的下载在前，系统的在后】。系统那条路已经不再使用，
             * 但老版本 App 排进系统队列的下载可能还在跑，一并显示完为止。
             */
            StringBuilder mine = new StringBuilder();
            synchronized (DownloadService.STATE) {
                for (DownloadService.Snapshot s : DownloadService.STATE.values()) {
                    if (mine.length() > 0) mine.append(',');
                    mine.append("{\"id\":\"").append(s.id).append("\"")
                        .append(",\"title\":").append(jsonStr(s.title))
                        .append(",\"total\":").append(s.total)
                        .append(",\"done\":").append(s.done)
                        .append(",\"status\":\"").append(s.status).append("\"}");
                }
            }

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return "[" + mine + "]";
            long[] ids;
            synchronized (downloadIds) {
                ids = new long[downloadIds.size()];
                for (int i = 0; i < ids.length; i++) ids[i] = downloadIds.get(i);
            }
            if (ids.length == 0) return "[" + mine + "]";
            StringBuilder sb = new StringBuilder("[");
            boolean first = mine.length() == 0;
            if (!first) sb.append(mine);
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(ids))) {
                while (c != null && c.moveToNext()) {
                    String title = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
                    long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    String status = st == DownloadManager.STATUS_SUCCESSFUL ? "done"
                            : st == DownloadManager.STATUS_FAILED ? "error"
                            : st == DownloadManager.STATUS_PAUSED ? "paused" : "running";
                    long id = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                    if (!first) sb.append(',');
                    first = false;
                    sb.append("{\"id\":\"").append(id).append("\"")
                      .append(",\"title\":").append(jsonStr(title))
                      .append(",\"total\":").append(total)
                      .append(",\"done\":").append(done)
                      .append(",\"status\":\"").append(status).append("\"}");
                }
            } catch (Exception ignored) { }
            return sb.append(']').toString();
        }

        /**
         * 中断 / 删除一条下载。**连带文件一起删**。
         *
         * DownloadManager.remove() 一个方法把两件事都办了：正在下的会被停掉、
         * 已下完的连文件一起删——因为这个文件本来就是它替我们创建的，它是主人。
         * 我们只多做一步：把 id 从会话列表里摘掉，否则悬浮框还会一直查它。
         *
         * 【为什么不自己去 File.delete()】：Android 10 起是分区存储，
         * 下载目录里的文件轮不到我们直接删；绕过 DownloadManager 只会拿到
         * 一个权限异常，而它自己删是名正言顺的。
         */
        @JavascriptInterface
        public boolean removeDownload(String idStr) {
            // 我们自己的那条：id 是时间戳字符串，发个取消 Intent 让 Service 停下
            if (DownloadService.STATE.containsKey(idStr)) {
                Intent i = new Intent(MainActivity.this, DownloadService.class);
                i.setAction(DownloadService.ACTION_CANCEL);
                i.putExtra(DownloadService.EXTRA_ID, idStr);
                startService(i);
                DownloadService.STATE.remove(idStr);
                return true;
            }
            long id;
            try { id = Long.parseLong(idStr); } catch (Exception e) { return false; }
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return false;
            boolean ok;
            try { ok = dm.remove(id) > 0; } catch (Exception e) { ok = false; }
            synchronized (downloadIds) { downloadIds.remove(Long.valueOf(id)); }
            saveDownloadIds();
            return ok;
        }
    }

    private static String jsonStr(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(' ');
            else b.append(ch);
        }
        return b.append('"').toString();
    }

    private long versionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0L;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /*
     * 【返回键归我们管】。有网页历史就退栈（前端 popstate 会同步 UI：关抽屉 /
     * 回列表）；已经在根页就弹原生挽留框。这是 TWA 做不到、换原生的主要动机。
     */
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        showExitDialog();
    }

    private void showExitDialog() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("我走了你别再难过！")
                .setMessage("再按一次返回键退出")
                .setNegativeButton("离开", (d, w) -> finish())
                .setPositiveButton("留下", (d, w) -> d.dismiss())
                .create();
        // 挽留框亮着时再按一次返回键 → 真的退出
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                d.dismiss();
                finish();
                return true;
            }
            return false;
        });
        dialog.show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ── 摇一摇 → 通知网页（比网页端 devicemotion 稳） ─────────────────
    @Override
    protected void onResume() {
        super.onResume();
        if (sensors != null) {
            Sensor acc = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc != null) sensors.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME);
        }
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (sensors != null) sensors.unregisterListener(this);
        if (web != null) web.onPause();
        /*
         * 【必须 flush，否则每次关掉 App 都要重新登录】。
         * WebView 的 cookie 先写在内存里，靠 CookieManager 异步落盘；进程被系统
         * 杀掉时没落盘的就丢了——即使后端给的是 30 天持久 cookie 也白搭。
         * 在这里显式落盘一次，登录态才能跨重启保留。
         */
        CookieManager.getInstance().flush();
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        long now = System.currentTimeMillis();
        if (now - lastSampleAt < 90) return;
        long dt = Math.max(1, now - lastSampleAt);
        lastSampleAt = now;
        float x = e.values[0], y = e.values[1], z = e.values[2];
        float dx = x - lastX, dy = y - lastY, dz = z - lastZ;
        lastX = x; lastY = y; lastZ = z;
        if (!primed) { primed = true; return; }
        double speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt * 1000;
        if (speed > 900 && now - lastShakeAt > 1200) {
            lastShakeAt = now;
            if (web != null) {
                web.evaluateJavascript(
                        "window.__sjShake && window.__sjShake()", null);
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @Override
    protected void onDestroy() {
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
