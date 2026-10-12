#!/usr/bin/env bash
# 一次跑完 7 个测试套件
set -uo pipefail
cd "$(dirname "$0")"
fail=0
for t in color ai anchors content pages background wiring; do
  echo
  echo "════════ $t ════════"
  node "$t.test.js" || fail=1
done
echo
if [ "$fail" = "0" ]; then echo "全部通过 ✓"; else echo "有测试失败 ✗"; fi
exit "$fail"
