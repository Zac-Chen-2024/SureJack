#!/usr/bin/env bash
# 端到端 demo 渲染：一条 ffmpeg 命令走完整条管线。
#
# 验证设计文档的五个机制：循环填充、片段级裁切、模糊填充、ASS 烧录、混音。
set -euo pipefail

D=/root/SureJack/spikes/demo
EX=/root/SureJack/Example
FONTS=/usr/share/fonts/opentype/noto

SRC="$EX/QQ录屏20240929185220.mp4"
DUR=$(python3 -c "import json;print(json.load(open('$D/timings.json'))['durationMs']/1000)")

echo "→ 配音时长 ${DUR}s，背景视频 26.5s → 循环约 $(python3 -c "print(round($DUR/26.534,1))") 次"
echo "→ 开始合成（1080x1920，这一步要几分钟）…"

ffmpeg -hide_banner -loglevel error -stats -y \
  -stream_loop -1 -i "$SRC" \
  -i "$D/voice.mp3" \
  -i "$D/bgm.mp3" \
  -filter_complex "\
    [0:v]crop=1052:470:0:0,split=2[fg][bgsrc]; \
    [bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,\
gblur=sigma=8,scale=1080:1920,eq=brightness=-0.18:saturation=0.7[bg]; \
    [fg]scale=1080:-2[fgs]; \
    [bg][fgs]overlay=(W-w)/2:(H-h)/2[comp]; \
    [comp]ass=$D/subtitle.ass:fontsdir=$FONTS[v]; \
    [1:a]volume=1.0[voice]; \
    [2:a]volume=0.10[bgmq]; \
    [voice][bgmq]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]" \
  -map "[v]" -map "[a]" \
  -t "$DUR" -r 30 \
  -c:v libx264 -preset fast -crf 21 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  "$EX/包子.mp4"

echo ""
echo "→ 完成：$EX/包子.mp4"
ffprobe -hide_banner -loglevel error \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate \
  -show_entries format=duration,size -of default=nw=1 "$EX/包子.mp4"
