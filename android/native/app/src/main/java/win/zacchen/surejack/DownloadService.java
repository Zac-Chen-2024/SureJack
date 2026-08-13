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
import android.os.PowerManager;
import android.net.wifi.WifiManager;
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
    public static final String ACTION_PAUSE = "win.zacchen.surejack.DOWNLOAD_PAUSE";
    public static final String ACTION_RESUME = "win.zacchen.surejack.DOWNLOAD_RESUME";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_UA = "ua";
    public static final String EXTRA_ID = "id";

    private static final String CHANNEL = "download";
    /** 进行中的那条常驻通知。整个服务共用一条——单线程，同时只有一条在传 */
    private static final int FG_NOTIFY_ID = 4200;
    /**
     * 「已保存 / 失败」用【另一个 id】。
     *
     * ⚠️ 线上真事：一条 5MB 的小片子下完，弹的"已保存"通知用的是同一个
     * FG_NOTIFY_ID，把正在下的那条 458MB 的【进度条直接覆盖掉了】——
     * 而且它带 autoCancel，用户一点就没了。大文件还在后台好好地下，
     * 通知栏却什么都不剩，用户以为下载没了。
     */
    private static final int DONE_NOTIFY_ID = 4201;

    /** 一次读多少。64KB 是吞吐和唤醒次数之间的常用折中 */
    private static final int BUF = 64 * 1024;
    /**
     * 重连【不设次数上限】。
     *
     * 原来是 30 次封顶。但断线重连的语义应该是"只要用户还想要，就一直等"——
     * 网络断二十分钟（进电梯、坐地铁、换基站）之后放弃，等于把已经下了
     * 一半的几百 MB 扔掉，而那是几十分钟换来的。
     *
     * 无限重连是安全的，因为：① 每次都从断点接着传，不做无用功；
     * ② 退避到 60 秒一次，几乎不耗电；③ 用户随时能在通知栏点暂停停下来；
     * ④ 真正没救的错误（文件没了、登录过期）会直接失败，不进重连（见 isFatal）。
     */
    private static final long RETRY_BASE_MS = 2000;
    private static final long RETRY_MAX_MS = 60_000;

    /** 进度快照，给 Bridge.downloads() 读。key = 我们自己发的下载 id */
    public static final Map<String, Snapshot> STATE =
            Collections.synchronizedMap(new LinkedHashMap<String, Snapshot>());

    /** 正在跑的任务，用来响应取消 */
    private static final Map<String, Boolean> CANCELLED = new ConcurrentHashMap<>();

    /**
     * 【用户主动暂停】的那些。和"断线重连"是两回事，必须分开：
     * 重连是自动的、几秒后自己继续；暂停要人点了"继续"才会动。
     * 混成一个状态的话，界面只能写一句含糊的"已暂停"——用户以为要自己
     * 点一下才继续，实际上它自己会重连；反过来真暂停了他又干等。
     */
    private static final Map<String, Boolean> PAUSED = new ConcurrentHashMap<>();

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

    /**
     * 把进度写进磁盘 / 从磁盘读回来。
     *
     * ⚠️【STATE 只放内存是不够的】。线上真事：用户的下载栏和通知栏【同时变空】，
     * 而服务器日志显示文件还差 300MB 没下完、.part 还在手机上。原因是进程被
     * 回收了——STATE 是静态字段，进程一没就全丢，于是 App 里看不到任何下载，
     * 用户以为没下上，再点一次，又白白多起一条流。
     *
     * 存的是【身份和进度】，不是实时速度：id、标题、总长、已下、状态、URL。
     * 有了 URL，进程回来之后那条"没下完的"才点得动「继续」——
     * 而 .part 还在，一点就从断点接上，几十分钟的流量不白费。
     */
    private static final String PREFS = "sj_downloads";
    private static final String KEY_STATE = "state_v1";

    /** 存一行：id|状态|已下|总长|标题|url（标题和 url 做过转义，不会有竖线） */
    private void persist() {
        StringBuilder b = new StringBuilder();
        synchronized (STATE) {
            for (Snapshot s : STATE.values()) {
                if ("done".equals(s.status)) continue;      // 下完的不用记
                if (b.length() > 0) b.append('\n');
                b.append(s.id).append('|').append(s.status).append('|')
                 .append(s.done).append('|').append(s.total).append('|')
                 .append(esc(s.title)).append('|').append(esc(s.url));
            }
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_STATE, b.toString()).apply();
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("|", "\\p").replace("\n", " ");
    }

    private static String unesc(String s) {
        return s.replace("\\p", "|").replace("\\\\", "\\");
    }

    /**
     * 读回上次没下完的。**MainActivity 一启动就调**，这样即使服务没在跑，
     * 下载栏里也看得到"还有一条没下完"，而不是一片空白。
     *
     * 读回来的一律标成 paused：进程都换了，肯定没有线程在传，
     * 显示成"下载中"是骗人的。用户点「继续」才真正开始。
     */
    public static void restore(Context ctx) {
        String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_STATE, "");
        if (raw.isEmpty()) return;
        for (String line : raw.split("\n")) {
            String[] f = line.split("\\|", 6);
            if (f.length < 6) continue;
            if (STATE.containsKey(f[0])) continue;   // 正在跑的以内存里那份为准
            Snapshot s = new Snapshot();
            s.id = f[0];
            s.status = "paused";
            try { s.done = Long.parseLong(f[2]); } catch (Exception e) { s.done = 0; }
            try { s.total = Long.parseLong(f[3]); } catch (Exception e) { s.total = -1; }
            s.title = unesc(f[4]);
            s.url = unesc(f[5]);
            STATE.put(s.id, s);
        }
    }

    public static class Snapshot {
        public String id;
        public String title;
        public long total;      // -1 = 还不知道
        public long done;
        /** running（在传）| reconnecting（断了，自动重连中）| paused（用户按了暂停）| done | error */
        public String status;
        public String error;
        /** 最近一次测到的速度，字节/秒。给通知栏和网页显示用 */
        public long bps;
        /** 下载地址。进程重启之后「继续」要靠它重新发起 */
        public String url;
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
        String act = intent.getAction();
        if (ACTION_CANCEL.equals(act)) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id != null) { CANCELLED.put(id, true); PAUSED.remove(id); }
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(act) || ACTION_RESUME.equals(act)) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id == null) return START_NOT_STICKY;
            boolean pause = ACTION_PAUSE.equals(act);
            if (pause) PAUSED.put(id, true); else PAUSED.remove(id);
            Snapshot s = STATE.get(id);
            if (s != null) {
                s.status = pause ? "paused" : "running";
                notifyState(s);
                persist();
                /*
                 * 【进程重启之后的「继续」要重新起一条任务】。
                 * 从磁盘读回来的那条只是一份记录，没有线程在跑——
                 * 不重新发起的话，用户点了"继续"什么都不会发生。
                 * .part 还在，所以起来之后是从断点接着传，不是从头。
                 */
                if (!pause && !ACTIVE.containsKey(safeName(s.title)) && s.url != null) {
                    Intent again = new Intent(this, DownloadService.class)
                            .setAction(ACTION_START)
                            .putExtra(EXTRA_URL, s.url)
                            .putExtra(EXTRA_NAME, s.title)
                            .putExtra(EXTRA_COOKIE, intent.getStringExtra(EXTRA_COOKIE))
                            .putExtra(EXTRA_UA, intent.getStringExtra(EXTRA_UA));
                    STATE.remove(id);       // 旧记录让位给真正在跑的那条
                    startService(again);
                }
            }
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
        s.url = url;
        STATE.put(id, s);
        persist();

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
        /*
         * ⚠️【START_REDELIVER_INTENT，不是 START_NOT_STICKY】。
         *
         * 国产 ROM（她这台是 vivo）会在用户切出去之后把整个进程杀掉，
         * 前台服务也照杀不误。用 NOT_STICKY 的话服务【永远不会回来】，
         * 下载就此停住——用户看到的就是"切出去就暂停了"。
         * REDELIVER 会让系统把原来那个 Intent 重新投递一次，
         * 而 .part 文件还在，于是自动从断点接着传。
         */
        return START_REDELIVER_INTENT;
    }

    private void stopSelfIfIdle() {
        boolean busy = false;
        synchronized (STATE) {
            for (Snapshot s : STATE.values()) {
                /*
                 * ⚠️【等待重试的也算在忙】。断线之后要等几秒到几十秒才重试，
                 * 这段时间状态是 paused——只认 running 的话会在这里撤掉前台身份，
                 * 而失去前台身份的服务几秒内就会被系统回收，
                 * 那条正在等重试的下载就此消失。
                 */
                /*
                 * ⚠️【断线重连中和用户暂停的都算在忙】。线上踩过：一条小片子
                 * 下完时，大文件正处在断线重连（那时状态还叫 paused），
                 * 只认 running 的话这里判定"没事干了"→ 撤前台 → 通知消失、
                 * 进程随时可被系统回收，而那条 458MB 还在传。
                 */
                if ("running".equals(s.status) || "paused".equals(s.status)
                        || "reconnecting".equals(s.status)) { busy = true; break; }
            }
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
        /*
         * 【唤醒锁 + WiFi 锁】。屏幕一灭，系统会让 CPU 睡下去、WiFi 进省电模式，
         * 正在传的连接会卡住直到超时——表现同样是"放着不动就停了"。
         * 下载是用户明确要的、有限时长的任务，持锁是正当用途；
         * 两把锁都在 finally 里释放，绝不泄漏（泄漏就是持续耗电）。
         */
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        PowerManager.WakeLock wake = pm == null ? null
                : pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "surejack:download");
        WifiManager wm = (WifiManager) getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
        WifiManager.WifiLock wifi = wm == null ? null
                : wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "surejack:download");
        if (wake != null) wake.acquire(6 * 60 * 60 * 1000L);   // 带超时，绝不无限期持有
        if (wifi != null) wifi.acquire();
        try {
            downloadLocked(id, url, name, cookie, ua);
        } finally {
            if (wifi != null && wifi.isHeld()) wifi.release();
            if (wake != null && wake.isHeld()) wake.release();
        }
    }

    private void downloadLocked(String id, String url, String name, String cookie, String ua)
            throws IOException {
        File dir = new File(getExternalFilesDir(null), "dl");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("建不了下载目录");
        // .part 就是断点本身：它有多长，就说明已经下到哪儿了
        File part = new File(dir, safeName(name) + ".part");

        long total = -1;
        for (int attempt = 0; ; attempt++) {
            /*
             * 【用户按了暂停就停在这儿等】，而不是结束任务。
             * 结束的话服务会失去前台身份被回收，"继续"就没东西可继续了。
             * 在这儿转圈，.part 原样留着，点继续立刻接上。
             */
            while (Boolean.TRUE.equals(PAUSED.get(id))
                    && !Boolean.TRUE.equals(CANCELLED.get(id))) {
                Snapshot ps = STATE.get(id);
                if (ps != null && !"paused".equals(ps.status)) { ps.status = "paused"; notifyState(ps); }
                try { Thread.sleep(500); } catch (InterruptedException e) { return; }
            }
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
                    long tickAt = System.currentTimeMillis();
                    long tickBytes = 0;
                    while ((n = in.read(buf)) > 0) {
                        if (Boolean.TRUE.equals(CANCELLED.get(id))) {
                            mark(id, "error", "已取消");   // .part 留着，下次接着传
                            return;
                        }
                        // 【暂停要立刻停手】：跳出去让外层那个等待循环接管
                        if (Boolean.TRUE.equals(PAUSED.get(id))) break;

                        out.write(buf, 0, n);
                        done += n;
                        tickBytes += n;
                        Snapshot s = STATE.get(id);
                        if (s != null) {
                            s.done = done; s.total = total;
                            if (!"running".equals(s.status)) s.status = "running";
                        }
                        // 通知刷太勤会拖慢下载，1 秒一次足够；顺便算这一秒的速度
                        long now = System.currentTimeMillis();
                        if (now - lastNotify > 1000) {
                            long dt = now - tickAt;
                            if (s != null && dt > 0) s.bps = tickBytes * 1000 / dt;
                            tickAt = now; tickBytes = 0;
                            lastNotify = now;
                            if (s != null) { notifyState(s); persist(); }
                        }
                    }
                    // 因为暂停跳出来的：回外层等着，别当成传完
                    if (Boolean.TRUE.equals(PAUSED.get(id))) continue;
                }

                // 读完了：长度对得上就算成功（服务端给了长度时才校验）
                if (total > 0 && part.length() < total) {
                    throw new IOException("传输不完整：" + part.length() + "/" + total);
                }
                publish(part, name);
                Snapshot s = STATE.get(id);
                if (s != null) { s.done = part.length(); s.total = part.length(); }
                mark(id, "done", null);
                persist();
                notifyDone(name);
                return;

            } catch (IOException e) {
                /*
                 * 断了不是失败，是常态——【自动重连，不设次数上限】。
                 * .part 原样留着，下一轮从断点接着要。
                 *
                 * 但【有些错误重试一万次也没用】：文件被清掉了(404)、
                 * 登录过期(401/403)。那种要立刻失败并说清原因，
                 * 而不是让用户对着一个永远在"重连中"的进度条干等。
                 */
                if (isFatal(e.getMessage())) {
                    fail(id, name, String.valueOf(e.getMessage()));
                    return;
                }
                Snapshot s = STATE.get(id);
                if (s != null) {
                    s.status = "reconnecting";
                    s.bps = 0;
                    notifyState(s);
                }
                long wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (1L << Math.min(attempt, 5)));
                long until = System.currentTimeMillis() + wait;
                // 等待期间也要能响应暂停/取消，不能死睡
                while (System.currentTimeMillis() < until) {
                    if (Boolean.TRUE.equals(CANCELLED.get(id))
                            || Boolean.TRUE.equals(PAUSED.get(id))) break;
                    try { Thread.sleep(300); } catch (InterruptedException ignored) { return; }
                }
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

    /**
     * 这个错误重试还有意义吗。
     *
     * 网络类的（超时、连接重置、DNS）重试就能好；而 404（成片已被清理）、
     * 401/403（登录过期）重试一万次也是同一个结果——那种要立刻告诉用户，
     * 让他去重新点一次下载或者重新登录，而不是盯着"重连中"干等。
     */
    private static boolean isFatal(String msg) {
        if (msg == null) return false;
        return msg.contains("HTTP 401") || msg.contains("HTTP 403")
                || msg.contains("HTTP 404") || msg.contains("HTTP 410")
                || msg.contains("续传被拒");
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
        persist();
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

    // ── 通知 ───────────────────────────────────────────────────────────

    /**
     * 【下载期间通知栏全程挂着这一条】，包括断线重连和用户暂停的时候。
     *
     * 它是这条链路上用户唯一的抓手：切出 App 之后，进度、状态、暂停/继续
     * 全在这儿。中途消失过一次，用户就会以为下载没了、回去再点一遍——
     * 那正是同一条片子被下了三遍的来源。
     */
    private Notification buildFor(Snapshot s) {
        boolean paused = "paused".equals(s.status);
        boolean recon = "reconnecting".equals(s.status);
        String text;
        if (paused) text = "已暂停 · " + mb(s.done) + (s.total > 0 ? " / " + mb(s.total) : "");
        else if (recon) text = "断线了，正在自动重连 · 已下 " + mb(s.done);
        else {
            text = mb(s.done) + (s.total > 0 ? " / " + mb(s.total) : "")
                    + (s.bps > 0 ? " · " + speed(s.bps) : "");
        }

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
                .setSmallIcon(paused ? android.R.drawable.ic_media_pause
                        : android.R.drawable.stat_sys_download)
                .setContentTitle(s.title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        if (s.total > 0) b.setProgress(100, (int) (s.done * 100 / s.total), recon && s.done == 0);
        else b.setProgress(0, 0, true);

        // 【暂停 / 继续】：切出 App 之后这是唯一能操作的地方
        b.addAction(paused
                ? new NotificationCompat.Action(android.R.drawable.ic_media_play, "继续",
                    actionIntent(ACTION_RESUME, s.id))
                : new NotificationCompat.Action(android.R.drawable.ic_media_pause, "暂停",
                    actionIntent(ACTION_PAUSE, s.id)));
        return b.build();
    }

    private PendingIntent actionIntent(String action, String id) {
        Intent i = new Intent(this, DownloadService.class).setAction(action)
                .putExtra(EXTRA_ID, id);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        // requestCode 要按 action+id 区分，否则暂停和继续会共用同一个 PendingIntent
        return PendingIntent.getService(this, (action + id).hashCode(), i, flags);
    }

    private void notifyState(Snapshot s) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(FG_NOTIFY_ID, buildFor(s));
    }

    private static String mb(long b) {
        if (b <= 0) return "0MB";
        return (b / 1048576) + "MB";
    }

    private static String speed(long bps) {
        return bps >= 1048576 ? String.format("%.1f MB/s", bps / 1048576.0)
                : (bps / 1024) + " KB/s";
    }

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
                // 【立刻显示】。默认系统会压着不显示十秒，用户点完下载什么都看不到
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        if (total > 0) b.setProgress(100, (int) (done * 100 / total), false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    private void notifyDone(String name) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(DONE_NOTIFY_ID, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(name)
                .setContentText("已保存到「下载」")
                .setAutoCancel(true)
                .build());
    }

    private void notifyFailed(String name) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(DONE_NOTIFY_ID, new NotificationCompat.Builder(this, CHANNEL)
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
