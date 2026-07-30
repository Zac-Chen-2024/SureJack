package win.zacchen.surejack;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
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
import android.widget.Toast;

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
    private static final int REQ_FILE = 1001;

    private WebView web;
    private boolean pageReady = false;
    private ValueCallback<Uri[]> fileCallback;

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
                try {
                    String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                    r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                    r.addRequestHeader("User-Agent", userAgent);
                    r.setMimeType(mimeType);
                    r.setTitle(name);
                    r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(r);
                    Toast.makeText(MainActivity.this, "开始下载：" + name, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "下载失败", Toast.LENGTH_SHORT).show();
                }
            }
        });

        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);

        if (savedInstanceState == null) {
            web.loadUrl("https://" + HOST + "/?appVersion=" + versionCode());
        } else {
            web.restoreState(savedInstanceState);
            pageReady = true;
        }
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
