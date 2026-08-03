"""拟合水印：字号 / 字的不透明度 / 描边宽度 / 描边不透明度。（第二版：确认是思源黑体，且有一圈淡黑边）

第一版漏了描边——判据卡在"比背景暗 18 以上"，而那圈边最暗才低 12 级，被当噪声扔了。
这一版的判据分两套，各管一头：
  亮框 / 字心不透明度  ←  lift > 18      对【字号、字的不透明度】敏感
  暗环（最低 lift、暗像素数）←  lift < -6  对【描边宽度、描边不透明度】敏感
所以分两步扫：先定字号+不透明度，再定描边。一起扫要 2000 次渲染，没必要。

只量右边那个「周」——左边那个紧挨微信的半透明圆按钮，背景不干净。
"""
import os
import subprocess
import tempfile
import numpy as np
from PIL import Image

FONTS = '/root/SureJack/assets/fonts'
FAMILY = 'Source Han Sans CN Medium'
K = 1080 / 952

# —— 参考侧（原图坐标，只含右边那个周）——
REF = dict(x0=80, x1=120, y0=254, y1=302)


def stats(img, x0, x1, y0, y1):
    win = img[y0:y1, x0:x1].astype(float)
    bg = np.median(np.concatenate([win[:4], win[-4:]], axis=0), axis=0)
    lift = win.mean(axis=2) - bg.mean(axis=1)[None, :]
    ink = lift > 18
    if ink.sum() < 30:
        return None
    ys, xs = np.nonzero(ink)
    core = lift > np.percentile(lift[ink], 75)
    B = np.broadcast_to(bg.mean(axis=1)[None, :], win.shape[:2])
    alpha = float(np.median((win.mean(axis=2)[core] - B[core]) / (255.0 - B[core])))
    return dict(w=int(xs.max() - xs.min() + 1), h=int(ys.max() - ys.min() + 1), alpha=alpha,
                dmin=float(lift.min()), ndark=int((lift < -6).sum()))


def render(fs, fa, ow, oa, d, bg=(115, 63, 25)):
    """fa/oa = 字/描边的不透明度(0..1)；ASS 的 alpha 字节是"透明度"，所以取反。"""
    fh = f'{round((1 - fa) * 255):02X}'
    oh = f'{round((1 - oa) * 255):02X}'
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: W,{FAMILY},{fs},&H{fh}FFFFFF,&H{fh}FFFFFF,&H{oh}000000,&H00000000,0,0,0,0,100,100,0,0,1,{ow},0,7,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,W,,0,0,0,,周
"""
    ap, op, jp = os.path.join(d, 'a.ass'), os.path.join(d, 'o.png'), os.path.join(d, 'o.jpg')
    open(ap, 'w', encoding='utf-8').write(ass)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                    '-i', f'color=c=0x{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}:s=1080x1920:d=1',
                    '-vf', f'ass={ap}:fontsdir={FONTS}', '-frames:v', '1', op], check=True)
    # 和参考走同一条链路：降到截图分辨率 + JPEG
    Image.open(op).convert('RGB').resize((952, 1690), Image.LANCZOS).save(jp, quality=88)
    return np.asarray(Image.open(jp).convert('RGB'))


OUR = dict(x0=40, x1=110, y0=250, y1=320)

if __name__ == '__main__':
    ref = np.asarray(Image.open('/root/SureJack/screenshots/29226429dfbc84373ccd2156104f02a9.jpg')
                     .convert('RGB'))
    R = stats(ref, **REF)
    print(f"参考（右边那个周）：亮框 {R['w']}x{R['h']}  字心α={R['alpha']:.2f}  "
          f"最暗 {R['dmin']:.1f}  暗像素 {R['ndark']}\n")

    with tempfile.TemporaryDirectory() as d:
        # 第 1 步：字号 + 字的不透明度（描边先固定成一个中间值，它对亮框影响很小）
        best = (1e9, None)
        for fs in range(48, 70, 2):
            for fa in [x / 100 for x in range(38, 63, 3)]:
                s = stats(render(fs, fa, 1.0, 0.5, d), **OUR)
                if not s:
                    continue
                e = abs(s['w'] - R['w']) * 3 + abs(s['h'] - R['h']) * 3 + abs(s['alpha'] - R['alpha']) * 100
                if e < best[0]:
                    best = (e, (fs, fa, s))
        fs, fa, s = best[1]
        print(f"第1步 字号 {fs} 不透明度 {fa:.2f} → 亮框 {s['w']}x{s['h']} α={s['alpha']:.2f}")

        best = (1e9, None)
        for f2 in range(fs - 1, fs + 2):
            for a2 in [x / 100 for x in range(int(fa * 100) - 2, int(fa * 100) + 3)]:
                s = stats(render(f2, a2, 1.0, 0.5, d), **OUR)
                if not s:
                    continue
                e = abs(s['w'] - R['w']) * 3 + abs(s['h'] - R['h']) * 3 + abs(s['alpha'] - R['alpha']) * 100
                if e < best[0]:
                    best = (e, (f2, a2, s))
        fs, fa, s = best[1]
        print(f"第1步细扫 字号 {fs} 不透明度 {fa:.2f} → 亮框 {s['w']}x{s['h']} α={s['alpha']:.2f}\n")

        # 第 2 步：描边宽度 + 描边不透明度，对着暗环拟合
        best = (1e9, None)
        for ow in [0.5, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5]:
            for oa in [x / 100 for x in range(15, 95, 10)]:
                s = stats(render(fs, fa, ow, oa, d), **OUR)
                if not s:
                    continue
                e = abs(s['dmin'] - R['dmin']) * 3 + abs(s['ndark'] - R['ndark']) * 0.8 \
                    + abs(s['w'] - R['w']) * 2 + abs(s['h'] - R['h']) * 2
                if e < best[0]:
                    best = (e, (ow, oa, s))
        ow, oa, s = best[1]
        print(f"第2步 描边 {ow} 不透明度 {oa:.2f} → 最暗 {s['dmin']:.1f}（参考 {R['dmin']:.1f}）"
              f" 暗像素 {s['ndark']}（参考 {R['ndark']}） 亮框 {s['w']}x{s['h']} α={s['alpha']:.2f}")
        print(f"\n最终：字号 {fs}  字不透明度 {fa:.0%}  描边 {ow}  描边不透明度 {oa:.0%}")
