#!/usr/bin/env python3
"""从烧录好的视频里抽帧，统计黄色像素数量，验证卡拉OK扫光确实在推进。

原理：\\kf 生效时，随时间推移「已唱」的黄色部分应该单调增加。
如果三个时间点的黄色像素数几乎不变，说明 \\kf 没生效（整行同一个颜色）。

肉眼看容易自欺欺人（「好像是变了？」），像素数不会。
"""
import subprocess
import sys

VIDEO = "spikes/karaoke/out.mp4"
TIMESTAMPS = [0.5, 3.0, 5.5]


def extract_ppm(video: str, ts: float) -> bytes:
    """抽一帧，输出 P6 格式的 PPM 原始数据。"""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", str(ts), "-i", video, "-vframes", "1",
         "-pix_fmt", "rgb24", "-f", "image2pipe", "-vcodec", "ppm", "-"],
        capture_output=True, check=True,
    )
    return proc.stdout


def count_colors(ppm: bytes) -> tuple[int, int]:
    """返回 (黄色像素数, 白色像素数)。

    黄色 = 已唱（PrimaryColour），白色 = 未唱（SecondaryColour）。
    同时数白色，是为了区分两种失败：
      - 黄白都是 0  → 字幕根本没渲染（多半是字体族名错了）
      - 有白无黄变化 → 字幕渲染了，但 \\kf 没生效
    """
    parts = ppm.split(b"\n", 3)
    if parts[0] != b"P6":
        raise ValueError(f"不是 P6 格式的 PPM：{parts[0]!r}")
    pixels = parts[3]

    yellow = white = 0
    for i in range(0, len(pixels) - 2, 3):
        r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
        if r > 180 and g > 180:
            if b < 100:
                yellow += 1
            elif b > 180:
                white += 1
    return yellow, white


def main() -> int:
    yellows, whites = [], []
    print("  时间      黄色(已唱)   白色(未唱)")
    print("  " + "-" * 34)
    for ts in TIMESTAMPS:
        y, w = count_colors(extract_ppm(VIDEO, ts))
        yellows.append(y)
        whites.append(w)
        print(f"  t={ts:>4}s  {y:>10}   {w:>10}")

    print()

    if max(yellows) == 0 and max(whites) == 0:
        print("❌ 失败：全程既无黄色也无白色像素——字幕根本没渲染出来")
        print("   排查：ASS 里的 Fontname 是否精确等于 `fc-match` 报的族名？")
        print("   注意 fc-match 找不到时会静默回退到 DejaVu Sans（无中文字形）")
        return 1

    if not (yellows[0] < yellows[1] < yellows[2]):
        print("❌ 失败：黄色像素没有随时间单调增加")
        print(f"   实测：{yellows}")
        print("   字幕渲染出来了，但 \\kf 扫光没生效——整行是同一个颜色")
        print("   → NO-GO：设计文档第 7 节的卡拉OK模式要改")
        return 1

    print(f"✅ 通过：黄色像素单调增加 {yellows[0]} → {yellows[1]} → {yellows[2]}")
    print(f"   白色像素相应减少 {whites[0]} → {whites[1]} → {whites[2]}")
    print("   \\kf 卡拉OK 扫光在 libass 里确实生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
