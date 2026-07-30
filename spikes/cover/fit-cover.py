"""
把参考封面的标题**在原尺度上**拟合出来：字体 / 字号 / 描边宽度 / 字距 / 位置。

和 match-font.py 的区别：那个只回答"哪个字体最像"（比形状时缩放归一），
这个不缩放——渲染出来的字必须和参考图上的字【逐像素落在同一处】，
所以字号、字距、落点都是要解出来的量，而不是归一化掉的量。

搜索分两轮：先粗步长扫全场，再在赢家附近以 1 为步长收紧。
评分同样看两层（外轮廓 + 白心），取调和平均——只看外轮廓的话，
描边加粗能把任何瘦字撑成胖字的外形，字重就认不出来了。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import sys

sys.path.insert(0, '/root/SureJack/spikes/cover')
from importlib import import_module
mf = import_module('match-font')

TEXT = mf.TEXT
CANVAS = (1100, 340)          # 够放下 833x215 的字块 + 余量


def render(path, index, size, stroke, tracking):
    """按给定字距逐字画。PIL 没有字距参数，只能自己推进笔位"""
    f = ImageFont.truetype(path, size, index=index)
    outer_img = Image.new('L', CANVAS, 0)
    inner_img = Image.new('L', CANVAS, 0)
    do, di = ImageDraw.Draw(outer_img), ImageDraw.Draw(inner_img)
    x, y = 60, 40
    for ch in TEXT:
        do.text((x, y), ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
        di.text((x, y), ch, font=f, fill=255)
        x += f.getlength(ch) + tracking
    outer = np.asarray(outer_img) > 40
    inner = np.asarray(inner_img) > 40
    if not outer.any():
        return None
    ys, xs = np.nonzero(outer)
    return outer, inner, (xs.min(), ys.min(), xs.max(), ys.max())


def score_at_scale(ref_outer, ref_inner, m):
    """按外轮廓左上角对齐，【不缩放】直接比。尺寸不同的部分算作不相交"""
    outer, inner, (x0, y0, x1, y1) = m
    h, w = ref_outer.shape
    ho, wo = y1 - y0 + 1, x1 - x0 + 1
    H, W = max(h, ho), max(w, wo)
    ro = np.zeros((H, W), bool); ro[:h, :w] = ref_outer
    ri = np.zeros((H, W), bool); ri[:h, :w] = ref_inner
    co = np.zeros((H, W), bool); co[:ho, :wo] = outer[y0:y1 + 1, x0:x1 + 1]
    ci = np.zeros((H, W), bool); ci[:ho, :wo] = inner[y0:y1 + 1, x0:x1 + 1]
    o = (ro & co).sum() / max((ro | co).sum(), 1)
    i = (ri & ci).sum() / max((ri | ci).sum(), 1)
    return (0 if o + i == 0 else 2 * o * i / (o + i)), o, i, (wo, ho)


def search(ref_outer, ref_inner, path, index, sizes, strokes, tracks):
    best = (0.0, None)
    for size in sizes:
        for stroke in strokes:
            for tr in tracks:
                m = render(path, index, size, stroke, tr)
                if m is None:
                    continue
                s, o, i, dim = score_at_scale(ref_outer, ref_inner, m)
                if s > best[0]:
                    best = (s, dict(size=size, stroke=stroke, tracking=tr,
                                    outer=o, inner=i, dim=dim))
    return best


if __name__ == '__main__':
    ref_outer, ref_inner = mf.ref_masks()
    print(f'参考：{ref_outer.shape[1]}x{ref_outer.shape[0]}，'
          f'白心占比 {ref_inner.sum() / ref_outer.sum():.3f}\n')

    results = []
    for name, path, idx in mf.CANDIDATES:
        # 第一轮：粗扫
        s1 = search(ref_outer, ref_inner, path, idx,
                    range(180, 236, 4), range(2, 19, 2), range(-12, 13, 3))
        if s1[1] is None:
            continue
        b = s1[1]
        # 第二轮：在赢家附近收紧到步长 1
        s2 = search(ref_outer, ref_inner, path, idx,
                    range(b['size'] - 4, b['size'] + 5),
                    range(max(0, b['stroke'] - 2), b['stroke'] + 3),
                    range(b['tracking'] - 3, b['tracking'] + 4))
        best = max(s1, s2, key=lambda t: t[0])
        results.append((best[0], name, best[1]))
        d = best[1]
        print(f"{name:24s} 分 {best[0]:.4f}  外 {d['outer']:.4f} 内 {d['inner']:.4f}  "
              f"字号 {d['size']} 描边 {d['stroke']} 字距 {d['tracking']:+d}  "
              f"墨迹 {d['dim'][0]}x{d['dim'][1]}")

    win = max(results)
    print(f"\n最像的是：{win[1]}")
    print(f"  字号 {win[2]['size']}  描边 {win[2]['stroke']}  字距 {win[2]['tracking']:+d}  分 {win[0]:.4f}")
