#!/usr/bin/env bash
# 造一个中文 .doc 样本，用来验证 antiword / catdoc 的中文支持。
#
# ⚠️ 重要局限：LibreOffice 生成的 .doc 未必能代表真实世界里
# Word 2003 存出来的文件——真实文件的编码来路千奇百怪。
# 所以这个样本通过 ≠ 真实文件一定能过。它只能证伪，不能证真：
# 如果连这个干净的样本都读不出来，那真实文件更没戏。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

OUT=spikes/doc-parse/samples
mkdir -p "$OUT"

# 一段典型的营销号文案：含标点、数字、英文、百分号、感叹号
cat > "$OUT/sample.txt" <<'EOF'
震惊！这个方法99%的人都不知道

很多人每天花3个小时剪视频，结果播放量还不到500。
其实问题根本不在你的素材，而在于你的文案节奏。

我认识一个做AI赛道的博主，他用了这套方法之后，
单条视频涨粉2万+，转化率提升了3倍。

小说内容纯属虚构，无不良引导。
EOF

echo "→ 用 LibreOffice 转成 Word 2003 的 .doc 格式"
soffice --headless --convert-to doc:"MS Word 97" \
  --outdir "$OUT" "$OUT/sample.txt" >/dev/null 2>&1

echo "→ 产物："
ls -la "$OUT"/*.doc
file "$OUT"/sample.doc
