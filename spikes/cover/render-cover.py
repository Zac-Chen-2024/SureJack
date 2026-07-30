"""
按解出来的参数复刻封面，并和参考图做逐像素比对。

解出来的结论（见同目录三个 fit-*.py）：
  字体    思源黑体 Medium（SourceHanSansCN-Medium）
  字号    0.16429 × 画布宽（参考图 1260 宽 → 207 px）
  描边    0.0386 × 字号（→ 8 px），纯黑
  字色    纯白
  字距    +1 px（≈ 0，即字体默认步进）
  位置    水平居中、垂直居中（参考图墨迹中心 (629, 1119)，画布中心 (630, 1121)）
底图：原图按"宽度铺满"放大，再垂直裁到 9:16。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import sys

FONT = '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Medium.otf'
SIZE_RATIO = 0.16429     # 字号 / 画布宽（1260 宽 → 207 px）
STROKE_RATIO = 0.0386    # 描边 / 【字号】。写成字号的比例而不是画布的，
                         # 换分辨率时描边和字才会一起缩，不会一个胖一个瘦
TRACKING = 1             # 字距（1260 宽下 +1 px）


def render_cover(bg_path: str, title: str, W: int, H: int) -> Image.Image:
    """底图按宽度铺满、垂直居中裁切；标题白字黑边、居中"""
    bg = Image.open(bg_path).convert('RGB')
    scale = max(W / bg.width, H / bg.height)
    bw, bh = int(round(bg.width * scale)), int(round(bg.height * scale))
    bg = bg.resize((bw, bh), Image.LANCZOS)
    canvas = bg.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))

    size = int(round(W * SIZE_RATIO))
    stroke = max(1, int(round(size * STROKE_RATIO)))
    f = ImageFont.truetype(FONT, size)
    tracking = TRACKING * W / 1260

    # 先量墨迹尺寸，才能真正居中——用 advance 居中会偏，
    # 因为首尾字的左右留白不对称（尤其"啦"这种左右结构）
    probe = Image.new('L', (W * 2, H), 0)
    d = ImageDraw.Draw(probe)
    x = W // 2
    for ch in title:
        d.text((x, H // 4), ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
        x += f.getlength(ch) + tracking
    ink = np.asarray(probe) > 40
    ys, xs = np.nonzero(ink)
    x0 = W // 2 + (W - (xs.max() - xs.min() + 1)) // 2 - xs.min()
    y0 = H // 4 + (H - (ys.max() - ys.min() + 1)) // 2 - ys.min()

    d = ImageDraw.Draw(canvas)
    x = x0
    for ch in title:
        d.text((x, y0), ch, font=f, fill=(255, 255, 255),
               stroke_width=stroke, stroke_fill=(0, 0, 0))
        x += f.getlength(ch) + tracking
    return canvas


if __name__ == '__main__':
    REF = '/root/SureJack/Material/cover/reference.png'
    SRC = '/root/SureJack/Material/cover/66f6f84a4809259a9573c449381e529c.jpg'
    OUT = '/root/SureJack/screenshots/cover-repro.png'
    ref = Image.open(REF).convert('RGB')
    W, H = ref.size

    out = render_cover(SRC, '后续来啦', W, H)
    out.save(OUT)
    print('复刻图 →', OUT)

    # 只比字：底图是另一张分辨率的图，比整幅没有意义
    sys.path.insert(0, '/root/SureJack/spikes/cover')
    from importlib import import_module
    mf = import_module('match-font')

    def masks(img):
        a = np.asarray(img).astype(int)
        band = np.zeros(a.shape[:2], bool)
        band[mf.BAND[0]:mf.BAND[1]] = True
        dark = (a.max(axis=2) < 70) & band
        outer = mf.fill_holes(dark)
        return outer, outer & ~dark

    ro, ri = masks(ref)
    co, ci = masks(out)
    o = (ro & co).sum() / (ro | co).sum()
    i = (ri & ci).sum() / (ri | ci).sum()
    print(f'外轮廓 IoU {o:.4f}   白心 IoU {i:.4f}')
    ys, xs = np.nonzero(ro); cys, cxs = np.nonzero(co)
    print(f'参考墨迹 x {xs.min()}..{xs.max()} y {ys.min()}..{ys.max()}')
    print(f'复刻墨迹 x {cxs.min()}..{cxs.max()} y {cys.min()}..{cys.max()}')

    # 差异图：红=只有参考有，绿=只有复刻有，白=重合
    diff = np.zeros((*ro.shape, 3), np.uint8)
    diff[..., 0] = (ro & ~co) * 255
    diff[..., 1] = (co & ~ro) * 255
    both = ro & co
    diff[both] = 255
    Image.fromarray(diff[mf.BAND[0] - 40:mf.BAND[1] + 40]).save(
        '/root/SureJack/screenshots/cover-diff.png')
    print('差异图 → screenshots/cover-diff.png（红=参考多出，绿=复刻多出，白=重合）')
