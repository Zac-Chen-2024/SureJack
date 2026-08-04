package win.zacchen.surejack;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

/**
 * 「片子做完了」的通知。
 *
 * ── 为什么是轮询，不是推送 ──────────────────────────────────────────
 * 真推送要走 FCM：要 Google 账号、要 google-services.json、服务端要接
 * 推送 SDK。这个 app 只有两个用户、一台自己的服务器，为一条"合成完了"
 * 的提示引入整套推送基建不划算。WorkManager 周期任务能在应用被杀之后
 * 照样醒来，够用。
 *
 * ⚠️【15 分钟是系统下限，不是我们挑的】。Android 对周期任务的最小间隔
 * 就是 15 分钟，填更小的值会被系统悄悄改回 15。所以最坏情况下通知会晚
 * 十几分钟——而一条片子本来就要烧十几分钟，这个延迟是可以接受的。
 * app 开着的时候不靠它：前端看到状态变化会立刻走 SJNative.notify 弹一条。
 *
 * ── 会话怎么带 ──────────────────────────────────────────────────────
 * 直接从 WebView 的 CookieManager 取——用户在网页里登录过，cookie 就在
 * 那儿。不另存一份 token：多一份就多一个会过期、会对不上的东西。
 * 没有 cookie（没登录过）就安静地什么都不做。
 */
public class NotifyWorker extends Worker {

    private static final String PREFS = "surejack.notify";
    private static final String KEY_SINCE = "since";
    private static final String CHANNEL = "film-done";
    private static final String WORK_NAME = "surejack-notify";

    public NotifyWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    /** 装上就排一次周期任务。KEEP：已经排过就不要重排，否则每次开 app 都把计时清零 */
    public static void schedule(Context ctx) {
        Constraints c = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                NotifyWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(c)
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String cookie = CookieManager.getInstance().getCookie(MainActivity.BASE_URL);
        if (cookie == null || cookie.isEmpty()) return Result.success();   // 没登录过

        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long since = sp.getLong(KEY_SINCE, 0L);

        try {
            URL url = new URL(MainActivity.BASE_URL + "/api/notifications?since=" + since);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("Cookie", cookie);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            if (conn.getResponseCode() != 200) return Result.success();

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject o = new JSONObject(sb.toString());
            JSONArray items = o.optJSONArray("items");
            long newest = since;
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    notifyDone(ctx, it.optString("name", "视频"), it.optString("projectId", ""));
                    newest = Math.max(newest, it.optLong("finishedAt", 0L));
                }
            }
            /*
             * 【第一次运行也要把水位记下来】。不记的话 since 一直是 0，
             * 服务端每次都回"最近 6 小时的全部"，同一条片子会被反复通知。
             */
            long now = o.optLong("now", System.currentTimeMillis());
            sp.edit().putLong(KEY_SINCE, Math.max(newest, since == 0 ? now : since)).apply();
            return Result.success();
        } catch (Exception e) {
            // 网络不好就下次再说。retry 会让它更频繁地醒来，没必要
            return Result.success();
        }
    }

    /** 弹一条。点了直接打开 app */
    public static void notifyDone(Context ctx, String name, String projectId) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "视频合成完成", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("片子烧录完成时提醒你");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(name + " 合成好了")
                .setContentText("点开就能看，也可以直接下载")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        /*
         * 用项目 id 的哈希当通知 id：同一条片子重烧不会堆出好几条，
         * 不同片子各占一条。用固定 id 会互相覆盖，用随机 id 会堆满通知栏。
         */
        nm.notify(projectId.isEmpty() ? 1 : projectId.hashCode(), n);
    }
}
