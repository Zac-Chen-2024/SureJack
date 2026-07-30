"""
字体已经认出来是思源黑体 Medium（见 fit-glyphs.py 的字重曲线），
这一步解剩下的四个量：**字号 / 描边宽度 / 字距 / 落点**。

和前面两个脚本不同，这里【不缩放、不归一】——渲染出来的字要落在参考图的
同一批像素上，所以位置是要解的量。评分仍是两层（外轮廓 + 白心）的调和平均。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import sys

sys.path.insert(0, '/root/SureJack/spikes/cover')
from importlib import import_module
mf = import_module('match-font')

FONT = '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Medium.otf'
TEXT = mf.TEXT
REF_W, REF_H = 1260, 2242


def ref_full():
    """整图尺度的两层掩膜（不裁切，位置信息要留着）"""
    a = np.asarray(Image.open(mf.REF).convert('RGB')).astype(int)
    band = np.zeros(a.shape[:2], bool)
    band[mf.BAND[0]:mf.BAND[1]] = True
    dark = (a.max(axis=2) < 70) & band
    outer = mf.fill_holes(dark)
    return outer, outer & ~dark


def render_full(size, stroke, tracking, x, y):
    """在整图画布上按给定参数画标题，返回两层掩膜"""
    f = ImageFont.truetype(FONT, size)
    oi = Image.new('L', (REF_W, REF_H), 0)
    ii = Image.new('L', (REF_W, REF_H), 0)
    do, di = ImageDraw.Draw(oi), ImageDraw.Draw(ii)
    cx = x
    for ch in TEXT:
        do.text((cx, y), ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
        di.text((cx, y), ch, font=f, fill=255)
        cx += f.getlength(ch) + tracking
    return np.asarray(oi) > 40, np.asarray(ii) > 40


def score(ro, ri, co, ci):
    o = (ro & co).sum() / max((ro | co).sum(), 1)
    i = (ri & ci).sum() / max((ri | ci).sum(), 1)
    return (0 if o + i == 0 else 2 * o * i / (o + i)), o, i


def main():
    ro, ri = ref_full()
    ys, xs = np.nonzero(ro)
    print(f'参考标题墨迹：x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}'
          f'  ({xs.max() - xs.min() + 1} x {ys.max() - ys.min() + 1})')

    best = (0.0, None)
    # 粗扫：字号/描边/字距，落点先用墨迹左上角对齐推出来
    for size in range(198, 217, 2):
        for stroke in range(6, 15, 2):
            for tracking in range(-8, 9, 2):
                co, ci = render_full(size, stroke, tracking, 300, 1000)
                cys, cxs = np.nonzero(co)
                if len(cxs) == 0:
                    continue
                dx, dy = xs.min() - cxs.min(), ys.min() - cys.min()
                co, ci = render_full(size, stroke, tracking, 300 + dx, 1000 + dy)
                s, o, i = score(ro, ri, co, ci)
                if s > best[0]:
                    best = (s, (size, stroke, tracking, 300 + dx, 1000 + dy, o, i))
    print(f'粗扫最优 分 {best[0]:.4f}  {best[1]}')

    # 细扫：在最优附近步长 1，位置再 ±3 微调
    size0, stroke0, tr0, x0, y0, *_ = best[1]
    for size in range(size0 - 2, size0 + 3):
        for stroke in range(max(0, stroke0 - 2), stroke0 + 3):
            for tracking in range(tr0 - 2, tr0 + 3):
                for dx in range(-3, 4):
                    for dy in range(-3, 4):
                        co, ci = render_full(size, stroke, tracking, x0 + dx, y0 + dy)
                        s, o, i = score(ro, ri, co, ci)
                        if s > best[0]:
                            best = (s, (size, stroke, tracking, x0 + dx, y0 + dy, o, i))

    size, stroke, tracking, x, y, o, i = best[1]
    print(f'\n最终：字号 {size}  描边 {stroke}  字距 {tracking:+d}  起笔 ({x}, {y})')
    print(f'      外轮廓 IoU {o:.4f}   白心 IoU {i:.4f}   综合 {best[0]:.4f}')
    print(f'（相对画布：字号 {size / REF_W:.4f} 倍宽，起笔 y {y / REF_H:.4f} 倍高）')
    return best[1]


if __name__ == '__main__':
    main()
