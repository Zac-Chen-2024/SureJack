#!/usr/bin/env bash
# 对比 antiword / catdoc 在中文 .doc 上的表现。
# 注意：不用 set -e —— 某个工具失败是预期内的结果，不该中断整个对比。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

for f in spikes/doc-parse/samples/*.doc; do
  [ -e "$f" ] || { echo "samples/ 里没有 .doc 文件，先跑 make-sample.sh"; exit 1; }
  echo "═══════════════════════════════════════════════"
  echo "样本：$f"
  echo "  $(file -b "$f" | cut -c1-70)"
  echo "═══════════════════════════════════════════════"

  for cmd in "antiword" "antiword -m UTF-8.txt" "catdoc" "catdoc -d utf-8" "catdoc -s cp936 -d utf-8"; do
    echo "--- \$ $cmd"
    out=$($cmd "$f" 2>&1 | head -4)
    rc=$?
    echo "$out" | sed 's/^/    /'
    echo "    [退出码 $rc]"
  done
  echo
done
