"""
最终标定：Medium 字重下，三块文字的字号 / 描边 / MarginV。

⚠️【量法必须两边一致】。参考那边每一块是靠不同的颜色判据框出来的：
  标题      白色【字心】（白字黑边，字心最好认）
  字幕      黑色【字心】
  免责声明  黑色【描边】（浅灰字压在很亮的背景上，只有描边够黑）
所以候选也必须按同一个判据去量——拿"字心"和"描边外沿"比，
本身就差了两倍描边宽，标定出来的字号必然偏小。前几轮的反复就出在这儿。

参考侧的数还做了一次【列分段清洗】：微信的关闭按钮、画面里的暗背景块
都会被阈值掩膜算成文字，把外接框撑大。按列切成连通段之后，
文字是一串宽度相近的段，背景是孤立的一两段，一眼能分开。
"""
import subprocess
import tempfile
import os
import numpy as np
from PIL import Image

FONTS = '/root/SureJack/assets/fonts'
FAMILY = 'Source Han Sans CN Medium'
PLAY_W, PLAY_H = 1080, 1920

# 参考里量出来的（成片坐标）。量法见各自的 pick
TARGETS = [
    dict(name='片内标题', text='周周饿昏', align=8, top=103, w=446, h=104,
         colors='&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000',
         pick=lambda a: a.min(axis=2) > 200),          # 白字心
    dict(name='字幕', text='咬不死人', align=2, bottom=1011, w=217, h=51,
         colors='&H00000000,&H00000000,&H00FFFFFF,&H00000000',
         pick=lambda a: a.max(axis=2) < 70),           # 黑字心
    dict(name='免责声明', text='小说内容纯属虚构无不良引导', align=2, bottom=25, w=503, h=40,
         colors='&H00B4B4B4,&H00FFFFFF,&H00000000,&H00000000',
         pick=lambda a: a.max(axis=2) < 95),           # 黑描边
]


def render(t, fs, ol, mv):
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {PLAY_W}
PlayResY: {PLAY_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: X,{FAMILY},{fs},{t['colors']},0,0,0,0,100,100,0,0,1,{ol},0,{t['align']},60,60,{mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,X,,0,0,0,,{t['text']}
"""
    with tempfile.TemporaryDirectory() as d:
        ap, op = os.path.join(d, 'a.ass'), os.path.join(d, 'o.png')
        open(ap, 'w', encoding='utf-8').write(ass)
        # 中灰底：白字心、黑字心、黑描边三种都能和背景分开
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                        '-i', f'color=c=0x808080:s={PLAY_W}x{PLAY_H}:d=1',
                        '-vf', f'ass={ap}:fontsdir={FONTS}', '-frames:v', '1', op], check=True)
        return np.asarray(Image.open(op).convert('RGB')).astype(int)


def box(img, pick):
    mask = pick(img)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return xs.min(), xs.max(), ys.min(), ys.max()


if __name__ == '__main__':
    print('字重 = Medium\n')
    for t in TARGETS:
        best = (1e9, None)
        for fs in range(40, 200):
            for ol in range(1, 9):
                b = box(render(t, fs, ol, 300), t['pick'])
                if b is None:
                    continue
                w, h = b[1] - b[0] + 1, b[3] - b[2] + 1
                err = abs(w - t['w']) * 2 + abs(h - t['h'])   # 宽度权重更高：它由字数×字号直接决定
                if err < best[0]:
                    best = (err, (fs, ol, w, h))
            if best[1] and best[1][2] > t['w'] + 60:
                break     # 已经明显超宽，再大没意义
        fs, ol, w, h = best[1]
        b = box(render(t, fs, ol, 300), t['pick'])
        got_top, got_bot = b[2], PLAY_H - b[3] - 1
        mv = 300 + ((t['top'] - got_top) if t['align'] == 8 else (t['bottom'] - got_bot))
        print(f"{t['name']}：字号 {fs} 描边 {ol}  →  {w}x{h}（参考 {t['w']}x{t['h']}）  MarginV {mv}",
              flush=True)
