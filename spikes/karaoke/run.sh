#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Spike 1 实测确认的路径与族名
FONTSDIR="/usr/share/fonts/opentype/noto"

echo "→ 确认字体族名可解析（写错会静默回退到无中文字形的字体）"
fc-match "Noto Sans CJK SC" | grep -q "Noto Sans CJK SC" \
  || { echo "❌ 字体族名 'Noto Sans CJK SC' 解析失败"; exit 1; }

echo "→ 生成 6 秒纯黑背景（1080x1920 竖屏）"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1080x1920:d=6:r=30" \
  -c:v libx264 -pix_fmt yuv420p \
  spikes/karaoke/bg.mp4

echo "→ 烧录卡拉OK字幕"
ffmpeg -hide_banner -loglevel error -y \
  -i spikes/karaoke/bg.mp4 \
  -vf "ass=spikes/karaoke/test.ass:fontsdir=${FONTSDIR}" \
  -c:v libx264 -pix_fmt yuv420p \
  spikes/karaoke/out.mp4

echo "→ 抽帧检查扫光是否推进"
python3 spikes/karaoke/check_karaoke.py
