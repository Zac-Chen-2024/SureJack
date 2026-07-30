/*
 * SureJack 定制的 TWA 启动 Activity。
 *
 * 相比 Bubblewrap 生成的默认版，只多做一件事：在启动 URL 后面带上本 App 的
 * versionCode（?appVersion=N），让网页能知道"当前装的是哪一版"，从而做自检
 * 更新（见 web 的 useAppUpdate）。其余（竖屏、启动图逻辑）保持默认。
 *
 * ⚠️ 构建流程会用它【覆盖】Bubblewrap 每次重新生成的 LauncherActivity.java
 * （见 android/README.md）。改包名的话记得同步改这里的 package。
 *
 * versionCode 走 PackageManager 读，不用 BuildConfig——AGP 8 默认不生成
 * BuildConfig，用它会编译报 cannot find symbol。
 */
package win.zacchen.surejack;

import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 透明背景在 Android 8.0 及以下设方向会崩，只在 Oreo 以上设。
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri uri = super.getLaunchingUrl();
        long versionCode = 0L;
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            versionCode = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                    ? pi.getLongVersionCode()
                    : (long) pi.versionCode;
        } catch (Exception e) {
            // 读不到就不带版本号，网页那边当作"未知"、不提示更新
        }
        return uri.buildUpon()
                .appendQueryParameter("appVersion", String.valueOf(versionCode))
                .build();
    }
}
