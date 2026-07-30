"""
逐字拟合：把「后」「续」「来」「啦」四个字**分开**和候选字体比。

为什么要分开：整行一起比时，四个字的位置误差会累加——第一个字差 2 像素，
到第四个字就差 8 像素，于是不管哪个字体分数都上不去，字体本身的差别
反而被排版误差淹没了。分开比，每个字各自对齐各自的外接框，比的就纯粹是
【这个字的骨架长什么样】。

排版（字号/字距/落点）另外解，见 fit-cover.py —— 那是两件事。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import sys

sys.path.insert(0, '/root/SureJack/spikes/cover')
from importlib import import_module
mf = import_module('match-font')

TEXT = mf.TEXT


def ref_glyphs():
    """把参考图上的四个字各自切出来，返回 [(外轮廓, 白心), ...]"""
    a = np.asarray(Image.open(mf.REF).convert('RGB')).astype(int)[mf.BAND[0]:mf.BAND[1]]
    dark = a.max(axis=2) < 70
    outer = mf.fill_holes(dark)
    inner = outer & ~dark
    cols = outer.sum(axis=0)
    runs, start = [], None
    for x in range(len(cols)):
        on = cols[x] > 0
        if on and start is None:
            start = x
        if not on and start is not None:
            if x - start > 8:
                runs.append((start, x - 1))
            start = None
    if start is not None:
        runs.append((start, len(cols) - 1))
    out = []
    for s, e in runs:
        o = outer[:, s:e + 1]
        ys = np.nonzero(o.any(axis=1))[0]
        sl = slice(ys.min(), ys.max() + 1)
        out.append((o[sl], inner[sl, s:e + 1]))
    return out, runs


def render_glyph(path, index, ch, size, stroke):
    f = ImageFont.truetype(path, size, index=index)
    W = H = size * 2
    oi = Image.new('L', (W, H), 0)
    ii = Image.new('L', (W, H), 0)
    ImageDraw.Draw(oi).text((size // 2, size // 2), ch, font=f, fill=255,
                            stroke_width=stroke, stroke_fill=255)
    ImageDraw.Draw(ii).text((size // 2, size // 2), ch, font=f, fill=255)
    o = np.asarray(oi) > 40
    i = np.asarray(ii) > 40
    if not o.any():
        return None
    ys, xs = np.nonzero(o)
    sl = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    return o[sl], i[sl]


def pad_to(m, H, W, dy=0, dx=0):
    out = np.zeros((H, W), bool)
    h, w = m.shape
    y0, x0 = max(0, dy), max(0, dx)
    out[y0:y0 + h, x0:x0 + w] = m[:H - y0, :W - x0]
    return out


def pair_score(ref_o, ref_i, cand_o, cand_i):
    """外轮廓左上角对齐，再在 ±3 像素内找最好的平移"""
    H = max(ref_o.shape[0], cand_o.shape[0]) + 6
    W = max(ref_o.shape[1], cand_o.shape[1]) + 6
    ro, ri = pad_to(ref_o, H, W, 3, 3), pad_to(ref_i, H, W, 3, 3)
    best = 0.0
    for dy in range(0, 7):
        for dx in range(0, 7):
            co, ci = pad_to(cand_o, H, W, dy, dx), pad_to(cand_i, H, W, dy, dx)
            o = (ro & co).sum() / max((ro | co).sum(), 1)
            i = (ri & ci).sum() / max((ri | ci).sum(), 1)
            s = 0 if o + i == 0 else 2 * o * i / (o + i)
            best = max(best, s)
    return best


if __name__ == '__main__':
    glyphs, runs = ref_glyphs()
    print('参考四个字的墨迹尺寸：', [(g[0].shape[1], g[0].shape[0]) for g in glyphs])
    print('列起点：', [r[0] for r in runs], '\n')

    table = []
    for name, path, idx in mf.CANDIDATES:
        per_char, params = [], []
        for ch, (ro, ri) in zip(TEXT, glyphs):
            best = (0.0, None)
            for size in range(190, 231, 2):
                for stroke in range(4, 17, 2):
                    m = render_glyph(path, idx, ch, size, stroke)
                    if m is None:
                        continue
                    s = pair_score(ro, ri, m[0], m[1])
                    if s > best[0]:
                        best = (s, (size, stroke))
            per_char.append(best[0])
            params.append(best[1])
        avg = sum(per_char) / len(per_char)
        table.append((avg, name, per_char, params))
        detail = ' '.join(f'{c}={s:.3f}' for c, s in zip(TEXT, per_char))
        print(f'{name:24s} 平均 {avg:.4f}   {detail}   参数 {params}')

    win = max(table)
    print(f'\n逐字最像的是：{win[1]}   平均 {win[0]:.4f}')
