"""
跑拟合：三块文字各自解出【字号 / 描边宽度 / 位置】。

窗口是肉眼核对过的（见 /tmp/band-*.png）：只框住文字本身，避开微信自己的
按钮和背景里的高光。掩膜再脏也不致命——比的是形状 IoU，两边渲染器一致。
"""
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, '/root/SureJack/spikes/subtitle')
from importlib import import_module
m = import_module('fit-ref')

CARD = (11, 963, 235, 1925)      # x0, x1, y0, y1（含头不含尾）
K = m.PLAY_W / (CARD[1] - CARD[0])   # 截图像素 → 成片坐标

card = np.asarray(Image.open(m.REF).convert('RGB')).astype(int)[CARD[2]:CARD[3], CARD[0]:CARD[1]]
CARD_H = card.shape[0]

# 每块：文字、窗口、"这是不是笔画"的判据、ASS 的颜色串、对齐方式
ELEMENTS = [
    dict(
        name='片内标题', text='周周饿昏',
        win=(55, 205, 250, 700),
        # 白字黑边：字心是很白的，外轮廓靠"白 or 黑"一起框
        inner=lambda b: b.min(axis=2) > 195,
        outer=lambda b: (b.min(axis=2) > 195) | (b.max(axis=2) < 70),
        style='&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,1,0,0,0',
        align=8,
    ),
    dict(
        name='字幕', text='咬不死人',
        win=(735, 820, 300, 670),
        # 黑字白边：字心是很黑的
        inner=lambda b: b.max(axis=2) < 70,
        outer=lambda b: (b.max(axis=2) < 70) | (b.min(axis=2) > 195),
        style='&H00000000,&H00000000,&H00FFFFFF,&H00000000,1,0,0,0',
        align=2,
    ),
    dict(
        name='免责声明', text='小说内容纯属虚构无不良引导',
        win=(1595, 1665, 190, 770),
        inner=lambda b: b.min(axis=2) > 175,
        outer=lambda b: (b.min(axis=2) > 175) | (b.max(axis=2) < 80),
        style='&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0',
        align=2,
    ),
]


def ref_masks(el):
    y0, y1, x0, x1 = el['win']
    b = card[y0:y1, x0:x1]
    inner = el['inner'](b)
    outer = m.fill_holes(el['outer'](b))
    ys, xs = np.nonzero(outer)
    box = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    # 位置：换算到成片坐标
    pos = dict(
        top=(y0 + ys.min()) * K,
        bottom=(CARD_H - (y0 + ys.max())) * K,
        width=(xs.max() - xs.min() + 1) * K,
        height=(ys.max() - ys.min() + 1) * K,
    )
    return outer[box], inner[box], pos


def cand_masks(el, fontsize, outline):
    """
    渲染候选，取两层掩膜。

    背景是中灰：凡是"离中灰足够远"的像素就是笔画（白字、黑字、深灰描边
    都满足），把它们填洞就是外轮廓；再按各自的字心颜色取内层。
    """
    img = m.render(el['text'], el['style'], fontsize, outline,
                   margin_v=400, align=el['align'])
    ink = np.abs(img - 128).max(axis=2) > 45
    if not ink.any():
        return None
    ys, xs = np.nonzero(ink)
    pad = 30
    sl = (slice(max(0, ys.min() - pad), ys.max() + pad),
          slice(max(0, xs.min() - pad), xs.max() + pad))
    sub = img[sl]
    outer = m.fill_holes(np.abs(sub - 128).max(axis=2) > 45)
    inner = el['inner'](sub)
    ys2, xs2 = np.nonzero(outer)
    box = (slice(ys2.min(), ys2.max() + 1), slice(xs2.min(), xs2.max() + 1))
    return outer[box], inner[box]


if __name__ == '__main__':
    for el in ELEMENTS:
        ro, ri, pos = ref_masks(el)
        print(f"\n=== {el['name']} ===", flush=True)
        print(f"  参考墨迹：{pos['width']:.0f} x {pos['height']:.0f}"
              f"   离顶 {pos['top']:.0f}  离底 {pos['bottom']:.0f}（成片坐标）", flush=True)

        def sweep(sizes, outlines, seed=(0.0, None)):
            best = seed
            for fs in sizes:
                for ol in outlines:
                    c = cand_masks(el, fs, ol)
                    if c is None:
                        continue
                    sc, o, i = m.two_layer_score(ro, ri, c[0], c[1])
                    if sc > best[0]:
                        best = (sc, (fs, ol, o, i))
            return best

        # 【两轮】：一轮到底要跑 1200 次 ffmpeg（约 20 分钟／块）。
        # 先粗扫定位，再在赢家附近步长 1 收紧，一百多次就够。
        rough = sweep(range(48, 200, 8), range(2, 15, 3))
        f0, o0 = rough[1][0], rough[1][1]
        fine = sweep(range(max(20, f0 - 7), f0 + 8), range(max(1, o0 - 2), o0 + 3), rough)
        fs, ol, o, i = fine[1]
        print(f'  → 字号 {fs}  描边 {ol}   （外 {o:.3f} 内 {i:.3f} 综合 {fine[0]:.3f}）', flush=True)
