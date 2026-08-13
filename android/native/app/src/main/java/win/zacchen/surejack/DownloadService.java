package win.zacchen.surejack;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.provider.MediaStore;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 自己实现的【可断点续传的后台下载】。
 *
 * ── 为什么不用系统的 DownloadManager ────────────────────────────────
 * 因为它【一次都没工作过】。翻遍服务器上从 7 月 30 日至今的全部 nginx 日志，
 * `AndroidDownloadManager` 这个 User-Agent 出现 0 次——横跨 App 版本 7 和 9、
 * 横跨两台不同的手机。每一条下载请求都来自 WebView 自己（UA 里带 `wv`）。
 *
 * 日志里还能看出交接是在哪一步断的：改造之前那些请求是 `499` + 传输
 * 【0 字节】——499 是"客户端自己断开"，0 字节说明 WebView 拿到响应头就走了，
 * 那正是它把下载交给系统下载器的动作。但系统下载器那条请求【从来没有
 * 到达服务器】。dm.enqueue() 抛的异常被一个 catch-all 吞掉，只弹了一句
 * "下载失败"，所以这件事安静地坏了很久。
 *
 * 与其继续猜是哪个 ROM 阉割了下载器，不如自己下——我们控制重试、控制续传，
 * 失败原因还能报回服务端（见 reportError）。
 *
 * ── 断点续传是这条链路的重点，不是锦上添花 ──────────────────────────
 * 成片是 480MB，用户在手机移动网络上、跨运营商，IP 中途都会换。实测三次
 * 尝试分别只传了 2 分 24 秒、3 秒、4 分 17 秒就断。这种网络下"一次拉完"
 * 本来就是小概率事件，唯一可行的办法是【断了接着传】：
 *   · 边下边写 .part 文件，进度就是它的长度，掉电、杀进程都不丢；
 *   · 重来时发 `Range: bytes=<已有长度>-`，服务端回 206 从那儿接着给；
 *   · 传完才移进"下载"目录，半截文件永远不会出现在相册/文件管理器里。
 *
 * 服务端那一半已经就绪（Accept-Ranges + 只有传到最后一个字节才算完成）。
 */
public class DownloadService extends Service {

    public static final String ACTION_START = "win.zacchen.surejack.DOWNLOAD_START";
    public static final String ACTION_CANCEL = "win.zacchen.surejack.DOWNLOAD_CANCEL";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_UA = "ua";
    public static final String EXTRA_ID = "id";

    private static final String CHANNEL = "download";
    private static final int FG_NOTIFY_ID = 4200;

    /** 一次读多少。64KB 是吞吐和唤醒次数之间的常用折中 */
    private static final int BUF = 64 * 1024;
    /**
     * 断了之后重试几次。
     *
     * 【每次重试都是从断点接着传】，不是从头——所以次数可以给得大方些：
     * 一条 480MB 的片子在信号飘的地铁上被切十几次是常事，每次能推进一点，
     * 加起来就下完了。次数太小的话，前面传的那些全白费。
     */
    private static final int MAX_RETRY = 30;
    /** 重试前等多久（毫秒）。指数退避，但封顶——网络回来时要能及时接上 */
    private static final long RETRY_BASE_MS = 2000;
    private static final long RETRY_MAX_MS = 30_000;

    /** 进度快照，给 Bridge.downloads() 读。key = 我们自己发的下载 id */
    public static final Map<String, Snapshot> STATE =
            Collections.synchronizedMap(new LinkedHashMap<String, Snapshot>());

    /** 正在跑的任务，用来响应取消 */
    private static final Map<String, Boolean> CANCELLED = new ConcurrentHashMap<>();

    /**
     * 已经在下的文件名。**同一条片子只许有一条流。**
     *
     * ⚠️ 线上实测：同一条 458MB 的成片同时有【三条流】在抢带宽——两条各自
     * 续传到 51MB 和 118MB，第三条每次从 0 开始。42 分钟里服务器发出 202MB，
     * 而实际最远只推进到 126MB，一多半流量白扔。
     *
     * 而她那条管子只有几十 KB/s。劈成三份不是"快三倍"，是三份都慢到没法用，
     * 还都在写同一个 .part 文件。重复的请求必须在这里挡掉。
     */
    private static final Map<String, Boolean> ACTIVE = new ConcurrentHashMap<>();

    public static class Snapshot {
        public String id;
        public String title;
        public long total;      // -1 = 还不知道
        public long done;
        public String status;   // running | paused | done | error
        public String error;
    }

    private ExecutorService pool;

    @Override
    public void onCreate() {
        super.onCreate();
        /*
         * 单线程：几百 MB 的下载并发跑只会互相抢带宽，在本来就不稳的网络上
         * 让每一条都更容易超时。排队一条条下，反而更快下完第一条。
         */
        pool = Executors.newSingleThreadExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        if (ACTION_CANCEL.equals(intent.getAction())) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id != null) CANCELLED.put(id, true);
            return START_NOT_STICKY;
        }

        final String url = intent.getStringExtra(EXTRA_URL);
        final String name = intent.getStringExtra(EXTRA_NAME);
        final String cookie = intent.getStringExtra(EXTRA_COOKIE);
        final String ua = intent.getStringExtra(EXTRA_UA);
        if (url == null || name == null) return START_NOT_STICKY;

        /*
         * 【同一个文件已经在下就直接忽略】。用户看不到进度时会反复点，
         * 每多一条流都是在抢本来就不够的带宽。
         */
        String key = safeName(name);
        if (Boolean.TRUE.equals(ACTIVE.get(key))) {
            return START_NOT_STICKY;
        }
        ACTIVE.put(key, true);

        final String id = String.valueOf(System.currentTimeMillis());
        Snapshot s = new Snapshot();
        s.id = id; s.title = name; s.total = -1; s.done = 0; s.status = "running";
        STATE.put(id, s);
        remember(id);

        /*
         * 【必须是前台服务】。Android 8 起后台进程随时会被冻结，
         * 而"后台下载"的字面意思就是用户切走之后还得接着下。
         * 前台服务 + 一条常驻通知是官方唯一支持的做法。
         */
        startForeground(FG_NOTIFY_ID, buildNotification(name, 0, -1, "正在下载"));

        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    download(id, url, name, cookie, ua);
                } catch (Throwable t) {
                    fail(id, name, String.valueOf(t));
                } finally {
                    CANCELLED.remove(id);
                    ACTIVE.remove(safeName(name));
                    stopSelfIfIdle();
                }
            }
        });
        return START_NOT_STICKY;
    }

    private void stopSelfIfIdle() {
        boolean busy = false;
        synchronized (STATE) {
            for (Snapshot s : STATE.values()) if ("running".equals(s.status)) { busy = true; break; }
        }
        if (!busy) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH);
            else stopForeground(false);
            stopSelf();
        }
    }

    /** 下一条。内部自带续传重试 */
    private void download(String id, String url, String name, String cookie, String ua)
            throws IOException {
        File dir = new File(getExternalFilesDir(null), "dl");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("建不了下载目录");
        // .part 就是断点本身：它有多长，就说明已经下到哪儿了
        File part = new File(dir, safeName(name) + ".part");

        long total = -1;
        for (int attempt = 0; attempt <= MAX_RETRY; attempt++) {
            if (Boolean.TRUE.equals(CANCELLED.get(id))) {
                /*
                 * ⚠️【取消不删 .part】。删掉的话下次点下载就要从第 0 字节重来，
                 * 而在一条几十 KB/s 的管子上，已经传下来的那几十 MB 是几十分钟
                 * 换来的。线上日志里"整条 0-480275839"反复出现，就是这么来的。
                 * 半成品留在应用私有目录里，用户看不见，也不占公共空间；
                 * 真不要了由 clearPart() 显式清（重下按钮）。
                 */
                mark(id, "error", "已暂停");
                return;
            }
            long have = part.exists() ? part.length() : 0;
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20_000);
                /*
                 * 【读超时不能太短】。移动网络卡顿几十秒是常态，超时太短会把
                 * 一条本来还活着的连接掐掉，白白浪费一次重试。
                 */
                conn.setReadTimeout(60_000);
                conn.setInstanceFollowRedirects(true);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                if (ua != null) conn.setRequestProperty("User-Agent", ua);
                if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-");

                int code = conn.getResponseCode();
                /*
                 * 要了 Range 却回 200 = 服务端不支持续传，只能从头来。
                 * 那就把 .part 清掉重下，不能把新数据接在旧数据后面——
                 * 那样拼出来的文件是坏的，而且坏得很隐蔽（能下完、播不了）。
                 */
                if (have > 0 && code == HttpURLConnection.HTTP_OK) {
                    part.delete();
                    have = 0;
                } else if (have > 0 && code != HttpURLConnection.HTTP_PARTIAL) {
                    throw new IOException("续传被拒：HTTP " + code);
                } else if (have == 0 && code != HttpURLConnection.HTTP_OK
                        && code != HttpURLConnection.HTTP_PARTIAL) {
                    throw new IOException("HTTP " + code);
                }

                // ⚠️ 不能用 getHeaderFieldLong：它是 API 24 的，而 minSdk 是 23
                long len = parseLong(conn.getHeaderField("Content-Length"), -1);
                if (total < 0) total = (len < 0) ? -1 : have + len;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(part, have > 0)) {
                    byte[] buf = new byte[BUF];
                    long done = have;
                    long lastNotify = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (Boolean.TRUE.equals(CANCELLED.get(id))) {
                            mark(id, "error", "已暂停");   // .part 留着，下次接着传
                            return;
                        }
                        out.write(buf, 0, n);
                        done += n;
                        Snapshot s = STATE.get(id);
                        if (s != null) { s.done = done; s.total = total; }
                        // 通知刷太勤会拖慢下载，1 秒一次足够
                        long now = System.currentTimeMillis();
                        if (now - lastNotify > 1000) {
                            lastNotify = now;
                            notifyProgress(name, done, total);
                        }
                    }
                }

                // 读完了：长度对得上就算成功（服务端给了长度时才校验）
                if (total > 0 && part.length() < total) {
                    throw new IOException("传输不完整：" + part.length() + "/" + total);
                }
                publish(part, name);
                Snapshot s = STATE.get(id);
                if (s != null) { s.done = part.length(); s.total = part.length(); }
                mark(id, "done", null);
                notifyDone(name);
                return;

            } catch (IOException e) {
                /*
                 * 断了不是失败，是常态。.part 原样留着，等下一轮从断点接着要。
                 * 只有重试次数用完了才算真失败。
                 */
                if (attempt >= MAX_RETRY) {
                    fail(id, name, "重试 " + MAX_RETRY + " 次仍失败：" + e);
                    return;
                }
                Snapshot s = STATE.get(id);
                if (s != null) s.status = "paused";
                long wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (1L << Math.min(attempt, 4)));
                try { Thread.sleep(wait); } catch (InterruptedException ignored) { return; }
                if (s != null) s.status = "running";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    /**
     * 把下好的 .part 移进系统「下载」目录。
     *
     * Android 10 起是分区存储，应用不能直接往公共目录写文件，只能通过
     * MediaStore 请一个 Uri 再往里倒。10 以下还能直接写。
     * 【传完才移】：半截文件永远不该出现在文件管理器里，用户点开一个
     * 播不了的视频，比看到"下载中"糟糕得多。
     */
    private void publish(File part, String name) throws IOException {
        String fileName = safeName(name);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = getContentResolver();
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            cv.put(MediaStore.Downloads.MIME_TYPE, "video/mp4");
            cv.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new IOException("系统不给写下载目录");
            try (InputStream in = new FileInputStream(part);
                 OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IOException("打不开下载目录");
                byte[] buf = new byte[BUF];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            cv.clear();
            cv.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(uri, cv, null, null);
        } else {
            File pub = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    fileName);
            try (InputStream in = new FileInputStream(part);
                 OutputStream out = new FileOutputStream(pub)) {
                byte[] buf = new byte[BUF];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
        part.delete();
    }

    private static long parseLong(String s, long dflt) {
        if (s == null) return dflt;
        try { return Long.parseLong(s.trim()); } catch (Exception e) { return dflt; }
    }

    /** 文件名里不能有的字符换掉，并保证 .mp4 结尾 */
    private static String safeName(String name) {
        String s = name == null ? "视频" : name.replaceAll("[/\\\\:*?\"<>|]", "_").trim();
        if (s.isEmpty()) s = "视频";
        return s.toLowerCase().endsWith(".mp4") ? s : s + ".mp4";
    }

    private void mark(String id, String status, String err) {
        Snapshot s = STATE.get(id);
        if (s != null) { s.status = status; s.error = err; }
    }

    private void fail(String id, String name, String reason) {
        mark(id, "error", reason);
        notifyFailed(name);
        reportError(reason);
    }

    /**
     * 把失败原因报回服务端。
     *
     * 【为什么值得多一次请求】：这条链路上的故障全发生在用户手机上，
     * 而我们手上只有服务器日志。系统下载器那次就是这么安静地坏了很久——
     * 异常被 catch 吞掉，只弹一句"下载失败"，服务端什么都看不到。
     * 失败本来就不该是沉默的。
     */
    private void reportError(final String reason) {
        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(MainActivity.BASE_URL + "/api/client-error")
                            .openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(10_000);
                    c.setReadTimeout(10_000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    String body = "{\"where\":\"download\",\"message\":"
                            + jsonStr(reason) + ",\"device\":" + jsonStr(Build.MODEL)
                            + ",\"sdk\":" + Build.VERSION.SDK_INT + "}";
                    c.getOutputStream().write(body.getBytes("UTF-8"));
                    c.getResponseCode();
                } catch (Exception ignored) {
                    // 报告失败就算了，不能因为报错本身再抛一次
                } finally {
                    if (c != null) c.disconnect();
                }
            }
        }).start();
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

    /** 记住这条下载的 id，App 重启后还认得（进度现算，不缓存） */
    private void remember(String id) {
        SharedPreferences sp = getSharedPreferences("sj_downloads", Context.MODE_PRIVATE);
        String raw = sp.getString("ours", "");
        sp.edit().putString("ours", raw.isEmpty() ? id : raw + "," + id).apply();
    }

    // ── 通知 ───────────────────────────────────────────────────────────
    private Notification buildNotification(String name, long done, long total, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "视频下载", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("下载进度");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(name)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        if (total > 0) b.setProgress(100, (int) (done * 100 / total), false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    private void notifyProgress(String name, long done, long total) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        String text = total > 0
                ? (done / 1048576) + "MB / " + (total / 1048576) + "MB"
                : (done / 1048576) + "MB";
        nm.notify(FG_NOTIFY_ID, buildNotification(name, done, total, text));
    }

    private void notifyDone(String name) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(FG_NOTIFY_ID, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(name)
                .setContentText("已保存到「下载」")
                .setAutoCancel(true)
                .build());
    }

    private void notifyFailed(String name) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(FG_NOTIFY_ID, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(name)
                .setContentText("下载失败，请重试")
                .setAutoCancel(true)
                .build());
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        if (pool != null) pool.shutdownNow();
        super.onDestroy();
    }
}
