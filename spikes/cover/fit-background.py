"""
解出参考封面的【底图变换】：原始封面 jpg 是怎么缩放、怎么裁到 9:16 的。

参考图 1260x2242（≈9:16），封面原图 500x1033（更窄更高），所以中间一定有
一次"放大 + 裁切"。要做到逐像素重合，这个变换必须解出来，不能凭感觉填。

做法：把原图按一系列缩放系数放大，在参考图上滑动找最小平均绝对差。
文字区域整块挖掉不参与比较——那儿被字盖住了，算进去只会把结果带偏。
"""
from PIL import Image
import numpy as np

REF = '/root/SureJack/Material/cover/reference.png'
SRC = '/root/SureJack/Material/cover/66f6f84a4809259a9573c449381e529c.jpg'
TEXT_BAND = (990, 1250)       # 标题所在行，比较时挖掉


def main():
    ref = np.asarray(Image.open(REF).convert('RGB').resize((315, 561), Image.BILINEAR)).astype(np.int16)
    src = Image.open(SRC).convert('RGB')
    mask = np.ones(ref.shape[:2], bool)
    mask[int(TEXT_BAND[0] / 2242 * 561):int(TEXT_BAND[1] / 2242 * 561)] = False

    best = (1e9, None)
    # 封面原图只有 500 宽，要铺满 1260 宽至少得放大 2.52 倍；
    # 低于这个数根本盖不满画布，扫也是白扫
    for scale in np.arange(2.50, 3.30, 0.01):
        w = int(round(src.width * scale * 315 / 1260))
        h = int(round(src.height * scale * 315 / 1260))
        if w < ref.shape[1] or h < ref.shape[0]:
            continue
        big = np.asarray(src.resize((w, h), Image.BILINEAR)).astype(np.int16)
        for oy in range(0, h - ref.shape[0] + 1, 2):
            for ox in range(0, w - ref.shape[1] + 1, 2):
                cut = big[oy:oy + ref.shape[0], ox:ox + ref.shape[1]]
                d = np.abs(cut - ref)[mask].mean()
                if d < best[0]:
                    best = (d, (scale, ox, oy, w, h))
    d, (scale, ox, oy, w, h) = best
    print(f'最佳：缩放 {scale:.2f}（缩略图尺度 {w}x{h}），裁切左上角 ({ox}, {oy})，平均差 {d:.2f}')
    # 换算回全尺寸
    k = 1260 / 315
    print(f'换算到 1260x2242：把原图缩放到 {int(w * k)}x{int(h * k)}，'
          f'从 ({int(ox * k)}, {int(oy * k)}) 裁 1260x2242')
    return scale, ox * k, oy * k, w * k, h * k


if __name__ == '__main__':
    main()
