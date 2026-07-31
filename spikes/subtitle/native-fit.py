"""
原尺度标定：解出【字号 / 描边 / MarginV】的绝对值。

── 为什么还要这一步 ────────────────────────────────────────────────────
run-fit.py 比形状时把候选缩放到了参考的尺寸——所以它给出的是【描边与字号
的比例】，字号本身被归一化掉了（字幕那块报"字号 54"，而实际是 80，
两者形状一样，只是大小不同）。

这里不缩放：直接渲染，量墨迹的外接框和位置，和参考的对。这样出来的
才是能填进 ASS 的数。
"""
import sys
import numpy as np

sys.path.insert(0, '/root/SureJack/spikes/subtitle')
from importlib import import_module
m = import_module('fit-ref')
rf = import_module('run-fit')

# run-fit 解出来的【描边/字号】比例
RATIO = {'片内标题': 5 / 144, '字幕': 3 / 54, '免责声明': 2 / 56}

# 参考里量到的墨迹（成片坐标）
REF_INK = {
    '片内标题': dict(w=461, h=117, top=98),
    '字幕': dict(w=227, h=61, bottom=1006),
    '免责声明': dict(w=625, h=79, bottom=29),
}


def ink_box(img):
    ink = np.abs(img - 128).max(axis=2) > 45
    ys, xs = np.nonzero(ink)
    return xs.min(), xs.max(), ys.min(), ys.max()


def measure(el, fontsize, outline, margin_v):
    img = m.render(el['text'], el['style'], fontsize, outline, margin_v, el['align'])
    x0, x1, y0, y1 = ink_box(img)
    return dict(w=x1 - x0 + 1, h=y1 - y0 + 1, top=y0, bottom=m.PLAY_H - y1 - 1)


if __name__ == '__main__':
    for el in rf.ELEMENTS:
        name = el['name']
        ref = REF_INK[name]
        r = RATIO[name]
        best = (1e9, None)
        # 先只对宽度：宽度只由字号和描边决定，和位置无关
        for fs in range(40, 200):
            ol = max(1, round(fs * r))
            got = measure(el, fs, ol, 300)
            err = abs(got['w'] - ref['w']) + abs(got['h'] - ref['h'])
            if err < best[0]:
                best = (err, (fs, ol, got))
        fs, ol, got = best[1]
        print(f'\n=== {name} ===', flush=True)
        print(f"  参考墨迹 {ref['w']}x{ref['h']}   拟合 {got['w']}x{got['h']}"
              f"   → 字号 {fs} 描边 {ol}（误差 {best[0]} px）", flush=True)

        # 位置：MarginV 是线性的，测一个点就能解出偏移
        probe = 300
        got = measure(el, fs, ol, probe)
        if el['align'] == 8:
            margin = probe + (ref['top'] - got['top'])
            print(f"  参考离顶 {ref['top']}，MarginV={probe} 时离顶 {got['top']}"
                  f"   → MarginV {margin}", flush=True)
        else:
            margin = probe + (ref['bottom'] - got['bottom'])
            print(f"  参考离底 {ref['bottom']}，MarginV={probe} 时离底 {got['bottom']}"
                  f"   → MarginV {margin}", flush=True)
