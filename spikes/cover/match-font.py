"""
认字体：把参考图上的「后续来啦」和候选字体渲染出来的字形做像素比对。

比两层，缺一不可：
  外层  黑色描边的外轮廓（把字里的白心填上）
  内层  白色字心本身
只比外层认不出字重——描边加粗一点就能把一个瘦字撑成胖字的外形。
两层一起比，"外轮廓这么大、里面的白心却只有这么细"就唯一地锁死了
「字重 + 描边宽度」这一对组合。

候选侧一次渲染取两张掩膜（描边版 / 无描边版，锚点相同），再用外轮廓的
外接框把两张一起归一到参考的尺度——两层各归各的会错位。
分数 = 外层 IoU 与内层 IoU 的调和平均（哪一层塌了都会立刻反映出来）。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

TEXT = '后续来啦'
REF = '/root/SureJack/Material/cover/reference.png'
BAND = (1000, 1250)          # 文字所在行区间：外面还有绿叶等深色像素，必须框住


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """从边界洪水填充背景，反过来就是把每个字里的白心补上"""
    h, w = mask.shape
    pad = np.zeros((h + 2, w + 2), bool)
    pad[1:-1, 1:-1] = mask
    # .copy() 不能省：fromarray 出来的图共享只读缓冲，floodfill 写不进去，
    # 结果是"一个像素都没填上"、掩膜直接变成整块——排查了半天的坑
    img = Image.fromarray((~pad).astype(np.uint8) * 255).copy()
    ImageDraw.floodfill(img, (0, 0), 128)
    outside = np.array(img) == 128
    return (~outside)[1:-1, 1:-1]


def ref_masks():
    a = np.asarray(Image.open(REF).convert('RGB')).astype(int)[BAND[0]:BAND[1]]
    dark = a.max(axis=2) < 70
    outer = fill_holes(dark)
    inner = outer & ~dark          # 描边以内的就是白心
    ys, xs = np.nonzero(outer)
    box = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    return outer[box], inner[box]


def render(path, index, size, stroke):
    """返回 (外轮廓掩膜, 白心掩膜)，两张都裁到外轮廓的外接框、尺寸一致"""
    f = ImageFont.truetype(path, size, index=index)
    pad = size
    W, H = size * len(TEXT) + pad * 2, size * 3
    outer_img = Image.new('L', (W, H), 0)
    ImageDraw.Draw(outer_img).text((pad, pad), TEXT, font=f, fill=255,
                                   stroke_width=stroke, stroke_fill=255)
    inner_img = Image.new('L', (W, H), 0)
    ImageDraw.Draw(inner_img).text((pad, pad), TEXT, font=f, fill=255)
    outer = np.asarray(outer_img) > 40
    inner = np.asarray(inner_img) > 40
    if not outer.any():
        return None
    ys, xs = np.nonzero(outer)
    box = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    return outer[box], inner[box]


def iou(ref: np.ndarray, cand: np.ndarray) -> float:
    """cand 缩放到 ref 的尺寸再算交并比"""
    c = np.asarray(Image.fromarray(cand.astype(np.uint8) * 255)
                   .resize((ref.shape[1], ref.shape[0]), Image.BILINEAR)) > 127
    u = (ref | c).sum()
    return (ref & c).sum() / u if u else 0.0


CANDIDATES = [
    # 思源黑体 = Noto Sans CJK / Noto Sans SC，Adobe 与 Google 同一批字形的两个名字。
    # 这里把这一族七个字重全列上，让"到底是哪个字重"由像素说话。
    ('思源黑体 ExtraLight', '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-ExtraLight.otf', 0),
    ('思源黑体 Light',      '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Light.otf', 0),
    ('思源黑体 Normal',     '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Normal.otf', 0),
    ('思源黑体 Regular',    '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Regular.otf', 0),
    ('思源黑体 Medium',     '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Medium.otf', 0),
    ('思源黑体 Bold',       '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Bold.otf', 0),
    ('思源黑体 Heavy',      '/root/SureJack/spikes/cover/fonts/SourceHanSansCN-Heavy.otf', 0),
    # 参照组：换一族字看看差多少，确认赢的不是"随便哪个黑体都行"
    ('文泉驿正黑',           '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 0),
    ('Noto Serif CJK SC Bold', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 2),
]

if __name__ == '__main__':
    ref_outer, ref_inner = ref_masks()
    print(f'参考：外轮廓 {ref_outer.shape[1]}x{ref_outer.shape[0]}，'
          f'白心占外轮廓 {ref_inner.sum() / ref_outer.sum():.3f}\n')

    rows = []
    for name, path, idx in CANDIDATES:
        best = (0.0, None)
        for size in range(140, 230, 2):
            for stroke in range(0, 22, 2):
                m = render(path, idx, size, stroke)
                if m is None:
                    continue
                o, i = iou(ref_outer, m[0]), iou(ref_inner, m[1])
                score = 0 if o + i == 0 else 2 * o * i / (o + i)
                if score > best[0]:
                    best = (score, (size, stroke, o, i, m[1].sum() / m[0].sum()))
        size, stroke, o, i, ratio = best[1]
        rows.append((best[0], name, best[1]))
        print(f'{name:24s} 分 {best[0]:.4f}  外 {o:.4f} 内 {i:.4f}  '
              f'(字号 {size} 描边 {stroke} 白心占比 {ratio:.3f})')

    win = max(rows)
    print(f'\n最像的是：{win[1]}   分 {win[0]:.4f}   字号 {win[2][0]} 描边 {win[2][1]}')
