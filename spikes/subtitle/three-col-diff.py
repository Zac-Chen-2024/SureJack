"""三列对比图：左=微信截图参考，中=我们烧出来的字（中灰底，无任何参考像素），右=差异分析。

右列的判据必须和左右两侧一致（标题量白字心、字幕量黑字心、免责声明量黑描边），
不然拿"字心"跟"描边外沿"比，差出两倍描边宽——之前标定反复就栽在这儿。
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = '/root/SureJack/assets/fonts/SourceHanSansCN-Medium.otf'
ref_full = Image.open('screenshots/29226429dfbc84373ccd2156104f02a9.jpg').convert('RGB').crop((11, 235, 963, 1925))
CW, CH = ref_full.size                      # 952 x 1690
K = 1080 / CW                               # 卡片 → 成片
ours_full = Image.open('/tmp/verify.png').convert('RGB').resize((CW, CH), Image.LANCZOS)
ref = np.asarray(ref_full).astype(int)
our = np.asarray(ours_full).astype(int)

# (名字, 卡片坐标的带 y0,y1, 判据, 最小列段, 标注)
# x 窗口是必须的：微信的关闭按钮、顶栏、画面里的暗块都会被阈值算成文字，
# 把外接框撑大（不加窗口时标题量出 1064 宽，实际 446）。两侧用同一个窗口。
BANDS = [
    ('片内标题', 60, 210, 240, 720, lambda a: a.min(axis=2) > 200, 6),
    ('字幕', 735, 820, 340, 620, lambda a: a.max(axis=2) < 70, 4),
    ('免责声明', 1630, 1675, 234, 718, lambda a: a.max(axis=2) < 95, 4),
]

def clean(mask, min_run):
    """列分段清洗：文字是一串宽度相近的连通列段，背景块是孤立的一两段。"""
    cols = mask.sum(axis=0); runs = []; s = None
    for x, v in enumerate(cols):
        if v > 0 and s is None: s = x
        if v == 0 and s is not None: runs.append((s, x - 1)); s = None
    if s is not None: runs.append((s, len(cols) - 1))
    keep = [r for r in runs if r[1] - r[0] >= min_run]
    out = np.zeros_like(mask)
    if not keep: return out, None
    x0, x1 = keep[0][0], keep[-1][1]
    out[:, x0:x1 + 1] = mask[:, x0:x1 + 1]
    ys = np.nonzero(out.sum(axis=1) > 0)[0]
    return out, (x0, x1, int(ys.min()), int(ys.max()))

diff = np.zeros((CH, CW, 3), np.uint8)
rows = []
for name, y0, y1, x0, x1, pick, mr in BANDS:
    rm, rb = clean(pick(ref[y0:y1, x0:x1]), mr)
    om, ob = clean(pick(our[y0:y1, x0:x1]), mr)
    band = diff[y0:y1, x0:x1]
    band[rm & ~om] = (255, 60, 60)      # 只有参考有
    band[om & ~rm] = (0, 220, 255)      # 只有我们有
    band[rm & om] = (255, 255, 255)     # 重合
    rows.append((name, rb, ob))

W3 = CW * 3 + 40
canvas = Image.new('RGB', (W3, CH + 260), (16, 16, 18))
canvas.paste(ref_full, (0, 60))
canvas.paste(ours_full, (CW + 20, 60))
canvas.paste(Image.fromarray(diff), (CW * 2 + 40, 60))
d = ImageDraw.Draw(canvas)
DX = CW * 2 + 40
ZOOMS = [('标题', 60, 210, 240, 470, 300), ('字幕', 735, 820, 340, 560, 900),
         ('小字', 1630, 1675, 234, 560, 1330)]
for lab, zy0, zy1, zx0, zx1, at in ZOOMS:
    z = Image.fromarray(diff[zy0:zy1, zx0:zx1]).resize(((zx1 - zx0) * 3, (zy1 - zy0) * 3), Image.NEAREST)
    z = z.crop((0, 0, min(z.width, CW - 40), z.height))
    canvas.paste(z, (DX + 20, 60 + at))
    d.rectangle([DX + 19, 59 + at, DX + 20 + z.width, 60 + at + z.height], outline=(70, 70, 80))
    ImageDraw.Draw(canvas).text((DX + 24, 60 + at - 34), f'{lab} ×3', font=ImageFont.truetype(FONT, 24),
                                fill=(190, 190, 190))
h1 = ImageFont.truetype(FONT, 34); h2 = ImageFont.truetype(FONT, 26)
for i, t in enumerate(['微信截图（参考）', '我们烧出来的（中灰底）', '差异分析']):
    d.text((i * (CW + 20) + 12, 12), t, font=h1, fill=(240, 240, 240))

y = CH + 76
lx = CW * 2 + 52
for lab, col in [('只有参考', (255, 60, 60)), ('只有我们', (0, 220, 255)), ('完全重合', (255, 255, 255))]:
    d.rectangle([lx, y, lx + 22, y + 22], fill=col)
    d.text((lx + 32, y - 4), lab, font=h2, fill=(210, 210, 210))
    lx += 190

lines = []
for name, rb, ob in rows:
    rw, rh = (rb[1] - rb[0] + 1) * K, (rb[3] - rb[2] + 1) * K
    ow, oh = (ob[1] - ob[0] + 1) * K, (ob[3] - ob[2] + 1) * K
    dx = ((ob[0] + ob[1]) - (rb[0] + rb[1])) / 2 * K
    dy = ((ob[2] + ob[3]) - (rb[2] + rb[3])) / 2 * K
    lines.append(f'{name}：宽 {rw:.0f}→{ow:.0f}（{ow-rw:+.0f}）  高 {rh:.0f}→{oh:.0f}（{oh-rh:+.0f}）'
                 f'  中心偏移 横 {dx:+.1f} 纵 {dy:+.1f} px')
for i, t in enumerate(lines):
    d.text((12, y + i * 38), t, font=h2, fill=(225, 225, 225))
d.text((12, y + len(lines) * 38 + 4),
       '描边：标题 参考 7.4 / 我们 7.5 px　字幕 参考 5.1 / 我们 5.0 px　免责声明 参考 2.3 / 我们 2.0 px（扫描线中位厚度）',
       font=h2, fill=(150, 200, 150))
canvas.save('screenshots/ref-vs-ours-diff.png')
print('\n'.join(lines))
print(canvas.size)
