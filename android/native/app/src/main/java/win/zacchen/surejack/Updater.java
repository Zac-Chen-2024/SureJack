package win.zacchen.surejack;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内自动更新。
 *
 * 每次启动向 https://<HOST>/api/app-version 问一次最新版本，比自己的 versionCode
 * 新就提示 → **在 App 内下载**（带进度）→ 直接唤起安装。用户不用再去 GitHub 找包、
 * 不用翻文件管理器。
 *
 * ⚠️ 【那一次"安装"确认点不掉】：安卓对普通应用强制要求安装前的系统确认弹窗，
 * 只有设备所有者(device owner)/系统应用才能静默装。所以"全自动无感更新"在侧载
 * 场景下不存在——我们能做到的极限是：自动检测 + 自动下载 + 一次系统确认。
 * （真要完全静默，只能上 Google Play 让 Play 商店托管更新。）
 *
 * 线程：网络在后台线程，UI 回主线程。不引第三方库（无 OkHttp 依赖）。
 */
final class Updater {

    private final Activity activity;
    private final String host;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean checking = false;

    Updater(Activity activity, String host) {
        this.activity = activity;
        this.host = host;
    }

    /** 启动时问一次。静默失败——检查更新失败绝不该打扰用户。 */
    void checkInBackground() {
        if (checking) return;
        checking = true;
        new Thread(() -> {
            try {
                JSONObject j = new JSONObject(httpGet("https://" + host + "/api/app-version"));
                long latest = j.optLong("versionCode", 0);
                String name = j.optString("versionName", "");
                String apkUrl = j.optString("apkUrl", "");
                String notes = j.optString("notes", "");
                if (latest > currentVersionCode() && !apkUrl.isEmpty()) {
                    ui.post(() -> promptUpdate(latest, name, apkUrl, notes));
                }
            } catch (Exception ignored) {
                // 网络不好/接口不可用 → 什么都不做，下次启动再说
            } finally {
                checking = false;
            }
        }).start();
    }

    private long currentVersionCode() {
        try {
            PackageInfo pi = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return Long.MAX_VALUE;   // 读不到就当自己是最新，宁可不提示也别误提示
        }
    }

    private void promptUpdate(long code, String name, String apkUrl, String notes) {
        if (activity.isFinishing()) return;
        String msg = (notes.isEmpty() ? "" : notes + "\n\n") + "现在更新？下载完会弹一次安装确认。";
        new AlertDialog.Builder(activity)
                .setTitle("有新版本 " + (name.isEmpty() ? ("v" + code) : name))
                .setMessage(msg)
                .setNegativeButton("以后再说", (d, w) -> d.dismiss())
                .setPositiveButton("立即更新", (d, w) -> download(apkUrl))
                .show();
    }

    private void download(String apkUrl) {
        AlertDialog progress = new AlertDialog.Builder(activity)
                .setTitle("正在下载更新")
                .setMessage("0%")
                .setCancelable(false)
                .create();
        progress.show();

        new Thread(() -> {
            File out = new File(activity.getCacheDir(), "update.apk");
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(apkUrl).openConnection();
                c.setInstanceFollowRedirects(true);   // GitHub 的 releases/latest 会 302
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.connect();
                int total = c.getContentLength();
                try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                    byte[] buf = new byte[16 * 1024];
                    int n, done = 0, lastPct = -1;
                    while ((n = in.read(buf)) > 0) {
                        fo.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100L / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                int p = pct;
                                ui.post(() -> progress.setMessage(p + "%"));
                            }
                        }
                    }
                }
                c.disconnect();
                ui.post(() -> { progress.dismiss(); install(out); });
            } catch (Exception e) {
                ui.post(() -> {
                    progress.dismiss();
                    Toast.makeText(activity, "下载更新失败，稍后再试", Toast.LENGTH_SHORT).show();
                });
            }
        }).start();
    }

    private void install(File apk) {
        // API 26+ 需要"安装未知应用"授权；没给就领用户去开
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity)
                    .setTitle("需要允许安装")
                    .setMessage("系统需要你允许 SureJack 安装应用，去打开这个开关就能完成更新。")
                    .setNegativeButton("取消", (d, w) -> d.dismiss())
                    .setPositiveButton("去设置", (d, w) -> {
                        try {
                            activity.startActivity(new Intent(
                                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName())));
                        } catch (Exception ignored) { }
                    })
                    .show();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                    activity, activity.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(activity, "唤起安装失败", Toast.LENGTH_SHORT).show();
        }
    }

    private static String httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        try (InputStream in = c.getInputStream()) {
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }
}
