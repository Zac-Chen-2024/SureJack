"""
把参考图（用户以前用剪映做的片子，微信截图）里三块文字的版式逐像素拟合出来：
字号 / 描边宽度 / 位置。

── 为什么不能靠"量一下再估" ────────────────────────────────────────────
上一轮我用阈值掩膜量了一遍，得出标题 162、免责声明 59——那两个数是错的：
掩膜把背景里的高光和暗部也算进了文字（甘蔗、鸡蛋、橙色背景），外接框直接
撑到整幅宽。而描边宽度压根没量。

正确做法和认封面字体那次一样：**拿 libass 真渲染候选参数，和参考做 IoU**。
渲染器一致（都是 libass），比出来的就是真的；掩膜脏不脏也不再要紧——
因为比的是形状重合度，背景噪点在两边都不出现。

── 两层比对 ────────────────────────────────────────────────────────────
外层  = 整个字（描边 + 字心）的实心轮廓
内层  = 字心本身
只比外层认不出描边宽度：描边加粗能把小字撑成大字的外形。两层一起比，
"外轮廓这么大、字心却只有这么细"就唯一地锁死了【字号 + 描边】这一对。
"""
from PIL import Image, ImageDraw
import numpy as np
import subprocess
import tempfile
import os

REF = '/root/SureJack/screenshots/29226429dfbc84373ccd2156104f02a9.jpg'
FONTS = '/usr/share/fonts/opentype/noto'
PLAY_W, PLAY_H = 1080, 1920


def frame_rect(img: np.ndarray) -> tuple[int, int, int, int]:
    """
    找出微信里那张视频卡片的边界。

    卡片外面是接近纯黑的聊天背景，卡片本身有内容——沿行/列求亮度，
    找连续的"亮区间"即可。找完用 9:16 校验，对不上就说明找歪了。
    """
    rows = img.mean(axis=(1, 2))
    cols = img.mean(axis=(0, 2))

    def longest_run(v, thr):
        best, cur = (0, 0), None
        for i, on in enumerate(v > thr):
            if on and cur is None:
                cur = i
            if not on and cur is not None:
                if i - cur > best[1] - best[0]:
                    best = (cur, i - 1)
                cur = None
        if cur is not None and len(v) - cur > best[1] - best[0]:
            best = (cur, len(v) - 1)
        return best

    y0, y1 = longest_run(rows, 60)
    x0, x1 = longest_run(cols, 60)
    return x0, x1, y0, y1


def render(text: str, style: str, fontsize: int, outline: int, margin_v: int,
           align: int) -> np.ndarray:
    """
    用 libass 渲染一行，返回 RGB。参数即 ASS 的字面参数。

    ⚠️【字段数必须正好 23】。V4+ 的 Style 行少一个多一个，libass 都是
    【整条丢掉、不报错】——画面上什么都没有，而你会以为是字号选得太小。
    style 参数已经带了 4 个颜色 + Bold/Italic/Underline/StrikeOut 共 8 个字段，
    模板里【不能】再补一遍那四个标志。踩过一次。
    """
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {PLAY_W}
PlayResY: {PLAY_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: X,Noto Sans CJK SC,{fontsize},{style},100,100,0,0,1,{outline},0,{align},60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,X,,0,0,0,,{text}
"""
    with tempfile.TemporaryDirectory() as d:
        ap, op = os.path.join(d, 'a.ass'), os.path.join(d, 'o.png')
        open(ap, 'w', encoding='utf-8').write(ass)
        subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            # 【中灰画布，不是黑】。标题的描边是深灰(0x202020)，字幕的字心是纯黑——
            # 在黑底上它们和背景分不开，外轮廓掩膜会退化成一整块矩形，比出来的
            # IoU 毫无意义。中灰让白、黑、深灰三种颜色都能和背景区分开。
            '-f', 'lavfi', '-i', f'color=c=0x808080:s={PLAY_W}x{PLAY_H}:d=1',
            '-vf', f'ass={ap}:fontsdir={FONTS}', '-frames:v', '1', op,
        ], check=True)
        return np.asarray(Image.open(op).convert('RGB')).astype(int)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """洪水填充背景再取反 = 把字里的洞补上，得到实心外轮廓"""
    h, w = mask.shape
    pad = np.zeros((h + 2, w + 2), bool)
    pad[1:-1, 1:-1] = mask
    # .copy() 不能省：fromarray 共享只读缓冲，floodfill 写不进去（踩过）
    img = Image.fromarray((~pad).astype(np.uint8) * 255).copy()
    ImageDraw.floodfill(img, (0, 0), 128)
    return (~(np.array(img) == 128))[1:-1, 1:-1]


def crop_ink(m: np.ndarray):
    ys, xs = np.nonzero(m)
    return m[ys.min():ys.max() + 1, xs.min():xs.max() + 1], (xs.min(), xs.max(), ys.min(), ys.max())


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """b 缩放到 a 的尺寸再算交并比"""
    bb = np.asarray(Image.fromarray(b.astype(np.uint8) * 255)
                    .resize((a.shape[1], a.shape[0]), Image.BILINEAR)) > 127
    u = (a | bb).sum()
    return (a & bb).sum() / u if u else 0.0


def two_layer_score(ref_outer, ref_inner, cand_outer, cand_inner):
    o, i = iou(ref_outer, cand_outer), iou(ref_inner, cand_inner)
    return (0 if o + i == 0 else 2 * o * i / (o + i)), o, i
