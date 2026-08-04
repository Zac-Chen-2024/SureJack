import os, subprocess, tempfile
import numpy as np
from PIL import Image
FONTS='/root/SureJack/assets/fonts'
STYLE="Style: Sub,Source Han Sans CN Medium,81,&H00000000,&H00000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,5,0,2,60,60,999,1"
def render(text, wrap=2):
    ass=f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: {wrap}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{STYLE}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Sub,,0,0,0,,{text}
"""
    with tempfile.TemporaryDirectory() as d:
        ap,op=os.path.join(d,'a.ass'),os.path.join(d,'o.png')
        open(ap,'w',encoding='utf-8').write(ass)
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi',
            '-i','color=c=0x808080:s=1080x1920:d=1','-vf',f'ass={ap}:fontsdir={FONTS}',
            '-frames:v','1',op],check=True)
        return np.asarray(Image.open(op).convert('RGB')).astype(int)

print('字数  墨迹宽度  左右边距  出界?   （画面 1080，安全区 960）')
for n in [14,15,16,17,18,19,20]:
    a=render('测试字幕文本内容排版宽度检查用例样本'[:1]*0 + ''.join('宽度测试字幕内容排版检查样本用例数据'[i%18] for i in range(n)))
    ink=np.abs(a-128).max(axis=2)>40
    xs=np.nonzero(ink.any(axis=0))[0]
    w=xs.max()-xs.min()+1
    print(f'{n:3d}   {w:5d}px   左{xs.min():4d} 右{1080-xs.max():4d}   {"★出界" if xs.min()<5 or xs.max()>1075 else ("贴边" if xs.min()<60 else "")}')
