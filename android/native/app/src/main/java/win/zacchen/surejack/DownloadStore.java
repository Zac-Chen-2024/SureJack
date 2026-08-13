package win.zacchen.surejack;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 下载记录的【唯一真相】。磁盘为准，内存不留副本。
 *
 * ── 为什么要有这个类 ────────────────────────────────────────────────
 * 改造之前，一条下载的状态散在【六个地方】：
 *
 *     STATE(内存 Map，key = System.currentTimeMillis())
 *   + SharedPreferences(磁盘)
 *   + ACTIVE(按文件名去重) + PAUSED + CANCELLED
 *   + downloadIds(老的系统下载器遗留)
 *
 * 六份状态没有单一真相来源，而且【身份是时间戳】——每次点下载都是一个新
 * id。由此长出来的不是六个 bug，是一个设计缺失的六种表现：
 *
 *   · 删了会复活：删除只清内存，磁盘那行没动，下次 restore 又读回来
 *   · 每杀一次进程攒一条幽灵：REDELIVER 用新 id 重投 + restore 复活旧 id
 *     = 同一条片子两条记录，其中一条永远没有线程在跑
 *   · 抹掉别人的记录：persist 拿内存整体覆写磁盘，而服务在【没有 Activity
 *     的进程】被拉起时内存是空的——一次覆写就把别的下载全清了
 *   · 失败伪装成已暂停：restore 无视磁盘上的 status，一律标 paused，
 *     error 根本没落盘，"登录过期"的解释重启后不复存在
 *
 * ── 两条设计 ────────────────────────────────────────────────────────
 *
 * ① **身份是 projectId**，不是时间戳。它稳定、唯一、和服务端对得上，
 *    于是"同一条片子"永远落在同一条记录上——去重是天然的，不需要额外的 Set。
 *
 * ② **每次操作都读盘 → 只改这一条 → 写回**。这个写法本身就消灭了
 *    "内存空的时候覆写掉别人"——因为压根不存在"内存里的全量"这回事。
 *
 * 序列化用平台自带的 org.json，不再手写转义（原来那套 esc/unesc 对含
 * 字面量 `\p` 的标题会往返损坏）。
 */
public final class DownloadStore {

    private static final String PREFS = "sj_downloads";
    /** v2 = 以 projectId 为 key 的 JSON 数组。v1 是老的竖线分隔格式 */
    private static final String KEY = "state_v2";
    private static final String KEY_V1 = "state_v1";
    /** 老的系统下载器遗留，迁移时一并清掉 */
    private static final String KEY_LEGACY_IDS = "ids";

    private DownloadStore() {}

    // ── 状态 ────────────────────────────────────────────────────────
    public static final String RUNNING = "running";
    /** 断了，正在自动重连。**不是用户暂停**，几秒后自己会继续 */
    public static final String RECONNECTING = "reconnecting";
    /** 用户按了暂停。要人点「继续」才会动 */
    public static final String PAUSED = "paused";
    public static final String DONE = "done";
    public static final String FAILED = "failed";

    public static final class Record {
        public String projectId;
        public String title;
        public String url;
        public String cookie;
        public long total = -1;      // -1 = 还不知道
        public long done;
        public String status = RUNNING;
        /** FAILED 时必须有，而且必须落盘——否则重启后用户不知道撞了什么墙 */
        public String error;
        /** 当前速度，字节/秒。**只在内存里**，不落盘（存了也立刻过期） */
        public transient long bps;
    }

    // ── 读 ──────────────────────────────────────────────────────────

    public static synchronized List<Record> all(Context ctx) {
        migrateIfNeeded(ctx);
        List<Record> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString(KEY, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                Record r = fromJson(arr.optJSONObject(i));
                if (r != null) out.add(r);
            }
        } catch (Exception ignored) { /* 读不出来就当空的，不能因此崩 */ }
        return out;
    }

    public static synchronized Record get(Context ctx, String projectId) {
        if (projectId == null) return null;
        for (Record r : all(ctx)) {
            if (projectId.equals(r.projectId)) return r;
        }
        return null;
    }

    // ── 写：永远是「读盘 → 改一条 → 写回」──────────────────────────

    public static synchronized void upsert(Context ctx, Record rec) {
        if (rec == null || rec.projectId == null) return;
        List<Record> list = all(ctx);
        boolean replaced = false;
        for (int i = 0; i < list.size(); i++) {
            if (rec.projectId.equals(list.get(i).projectId)) { list.set(i, rec); replaced = true; break; }
        }
        if (!replaced) list.add(rec);
        write(ctx, list);
    }

    /**
     * 删一条。**内存和磁盘一起删** —— 原来只清内存，于是每次重启它都复活，
     * 用户删几次回来几次。
     */
    public static synchronized void remove(Context ctx, String projectId) {
        if (projectId == null) return;
        List<Record> list = all(ctx);
        List<Record> kept = new ArrayList<>();
        for (Record r : list) {
            if (!projectId.equals(r.projectId)) kept.add(r);
        }
        write(ctx, kept);
    }

    /** 下载完成：记录没有存在的意义了 */
    public static synchronized void markDone(Context ctx, String projectId) {
        remove(ctx, projectId);
    }

    // ── 迁移 ────────────────────────────────────────────────────────

    /** 老记录的 url 形如 …/api/projects/&lt;projectId&gt;/film/download */
    private static final Pattern PROJECT_IN_URL =
            Pattern.compile("/api/projects/([^/]+)/film/download");

    public static String projectIdFromUrl(String url) {
        if (url == null) return null;
        Matcher m = PROJECT_IN_URL.matcher(url);
        return m.find() ? m.group(1) : null;
    }

    /**
     * 把 v1 的记录搬到 v2。**只跑一次**。
     *
     * v1 的 key 是时间戳，没法直接当身份用；但它存了 url，而 projectId
     * 就在 url 里——抠出来就能对上。抠不出来的丢弃：`.part` 文件还在，
     * 用户重新点一次下载会从断点接上，不会丢进度。
     */
    private static void migrateIfNeeded(Context ctx) {
        SharedPreferences sp = prefs(ctx);
        if (sp.contains(KEY)) return;
        String v1 = sp.getString(KEY_V1, "");
        List<Record> out = new ArrayList<>();
        if (!v1.isEmpty()) {
            for (String line : v1.split("\n")) {
                String[] f = line.split("\\|", 6);
                if (f.length < 6) continue;
                String pid = projectIdFromUrl(unescV1(f[5]));
                if (pid == null) continue;
                Record r = new Record();
                r.projectId = pid;
                r.status = PAUSED;      // 进程都换了，肯定没有线程在跑
                try { r.done = Long.parseLong(f[2]); } catch (Exception e) { r.done = 0; }
                try { r.total = Long.parseLong(f[3]); } catch (Exception e) { r.total = -1; }
                r.title = unescV1(f[4]);
                r.url = unescV1(f[5]);
                out.add(r);
            }
        }
        write(ctx, out);
        sp.edit().remove(KEY_V1).remove(KEY_LEGACY_IDS).apply();
    }

    private static String unescV1(String s) {
        return s == null ? "" : s.replace("\\p", "|").replace("\\\\", "\\");
    }

    // ── 内部 ────────────────────────────────────────────────────────

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void write(Context ctx, List<Record> list) {
        JSONArray arr = new JSONArray();
        for (Record r : list) {
            if (r == null || r.projectId == null) continue;
            arr.put(toJson(r));
        }
        prefs(ctx).edit().putString(KEY, arr.toString()).apply();
    }

    private static JSONObject toJson(Record r) {
        JSONObject o = new JSONObject();
        try {
            o.put("projectId", r.projectId);
            o.put("title", r.title == null ? "" : r.title);
            o.put("url", r.url == null ? "" : r.url);
            o.put("cookie", r.cookie == null ? "" : r.cookie);
            o.put("total", r.total);
            o.put("done", r.done);
            o.put("status", r.status == null ? RUNNING : r.status);
            if (r.error != null) o.put("error", r.error);
        } catch (Exception ignored) { }
        return o;
    }

    private static Record fromJson(JSONObject o) {
        if (o == null) return null;
        String pid = o.optString("projectId", "");
        if (pid.isEmpty()) return null;
        Record r = new Record();
        r.projectId = pid;
        r.title = o.optString("title", "");
        r.url = o.optString("url", "");
        r.cookie = o.optString("cookie", "");
        r.total = o.optLong("total", -1);
        r.done = o.optLong("done", 0);
        /*
         * ⚠️【如实恢复 status，不要一律标 paused】。
         *
         * 原来 restore 无视磁盘上的状态，一律当成"已暂停"，于是 404/401 这种
         * 【重试多少次都没用】的失败，重启后会伪装成一个带「继续」按钮的
         * 暂停项——用户点一次失败一次，而"文件没了 / 登录过期"的解释
         * 早就不见了。失败就该一直是失败，并且带着原因。
         *
         * 只有 RUNNING / RECONNECTING 需要落到 PAUSED：进程都换了，
         * 肯定没有线程在跑，显示成"下载中"是骗人的。
         */
        String st = o.optString("status", PAUSED);
        r.status = (RUNNING.equals(st) || RECONNECTING.equals(st)) ? PAUSED : st;
        String err = o.optString("error", "");
        r.error = err.isEmpty() ? null : err;
        return r;
    }

    /** 给网页下载栏用的 JSON。**进度现算，绝不缓存** */
    public static synchronized String toBridgeJson(Context ctx, java.util.Map<String, Record> live) {
        JSONArray arr = new JSONArray();
        for (Record disk : all(ctx)) {
            // 内存里有正在跑的那份就用它——进度和速度只有它是新的
            Record r = live.get(disk.projectId);
            if (r == null) r = disk;
            JSONObject o = toJson(r);
            try { o.put("bps", r.bps); } catch (Exception ignored) { }
            arr.put(o);
        }
        return arr.toString();
    }
}
