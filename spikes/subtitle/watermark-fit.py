"""拟合参考图左上角「周周」水印的字号与不透明度。

正向拟合，不是反推：候选按【和参考同样的链路】走一遍——
1080 渲染 → 降到截图分辨率(952 宽) → 压 JPEG → 再用【和量参考时一模一样的判据】量。
不这么做的话，半透明字的外接框会随阈值飘：阈值卡掉的抗锯齿边，
在 47% 不透明度下比在实心字上厚得多，直接反推字号必然偏小。
"""
import os
import subprocess
import tempfile
import numpy as np
from PIL import Image

FONTS = '/root/SureJack/assets/fonts'
FAMILY = 'Source Han Sans CN Medium'
K = 1080 / 952
TEXT = '周周'
# 参考侧量到的（截图坐标）
REF_W, REF_H, REF_A = 61, 33, 0.47
BG = (115, 63, 25)          # 字所在处的局部背景（棕）


def measure(img, x0, x1, y0, y1):
    """和量参考时同一套：逐列拿上下各 4 行的中位数当背景，比背景亮 18 以上算笔画。"""
    win = img[y0:y1, x0:x1].astype(float)
    bg = np.median(np.concatenate([win[:4], win[-4:]], axis=0), axis=0)
    lift = win.mean(axis=2) - bg.mean(axis=1)[None, :]
    ink = lift > 18
    if ink.sum() < 50:
        return None
    ys, xs = np.nonzero(ink)
    core = lift > np.percentile(lift[ink], 75)
    a = np.mean([np.median((win[:, :, c][core] - np.broadcast_to(bg[:, c][None, :], win.shape[:2])[core])
                           / (255.0 - np.broadcast_to(bg[:, c][None, :], win.shape[:2])[core])) for c in range(3)])
    return xs.max() - xs.min() + 1, ys.max() - ys.min() + 1, a


def render(fs, alpha, d):
    aa = f'{round((1 - alpha) * 255):02X}'          # ASS: 00=不透明, FF=全透
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: W,{FAMILY},{fs},&H{aa}FFFFFF,&H{aa}FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,W,,0,0,0,,{TEXT}
"""
    ap, op, jp = os.path.join(d, 'a.ass'), os.path.join(d, 'o.png'), os.path.join(d, 'o.jpg')
    open(ap, 'w', encoding='utf-8').write(ass)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                    '-i', f'color=c=0x{BG[0]:02x}{BG[1]:02x}{BG[2]:02x}:s=1080x1920:d=1',
                    '-vf', f'ass={ap}:fontsdir={FONTS}', '-frames:v', '1', op], check=True)
    # 走一遍参考图经历过的链路：缩到截图分辨率 + JPEG
    Image.open(op).convert('RGB').resize((952, 1690), Image.LANCZOS).save(jp, quality=88)
    return np.asarray(Image.open(jp).convert('RGB'))


if __name__ == '__main__':
    best = (1e9, None)
    with tempfile.TemporaryDirectory() as d:
        for fs in range(38, 76, 2):
            for alpha in [x / 100 for x in range(35, 76, 3)]:
                img = render(fs, alpha, d)
                m = measure(img, 40, 190, 250, 320)
                if not m:
                    continue
                w, h, a = m
                err = abs(w - REF_W) * 2 + abs(h - REF_H) * 2 + abs(a - REF_A) * 120
                if err < best[0]:
                    best = (err, (fs, alpha, w, h, a))
        fs, alpha, w, h, a = best[1]
        print(f'粗扫最优：字号 {fs}  不透明度 {alpha:.2f}  →  {w}x{h}  α={a:.2f}'
              f'（参考 {REF_W}x{REF_H}  α={REF_A:.2f}）')
        # 在最优附近细扫
        best2 = (1e9, None)
        for f2 in range(max(30, fs - 3), fs + 4):
            for a2 in [x / 100 for x in range(max(25, int(alpha * 100) - 6), int(alpha * 100) + 7)]:
                img = render(f2, a2, d)
                m = measure(img, 40, 190, 250, 320)
                if not m:
                    continue
                w, h, aa_ = m
                err = abs(w - REF_W) * 2 + abs(h - REF_H) * 2 + abs(aa_ - REF_A) * 120
                if err < best2[0]:
                    best2 = (err, (f2, a2, w, h, aa_))
        f2, a2, w, h, aa_ = best2[1]
        print(f'细扫最优：字号 {f2}  不透明度 {a2:.2f}  →  {w}x{h}  α={aa_:.2f}')
