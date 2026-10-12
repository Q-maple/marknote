#!/usr/bin/env bash
# 打两个可直接加载的包：
#   dist/marknote-firefox.zip  —— Firefox（about:debugging 用解压后的目录临时载入）
#   dist/marknote-chrome.zip   —— Chrome / Edge / Brave（chrome://extensions 加载已解压的扩展程序）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
rm -rf "$OUT"
mkdir -p "$OUT"

# 测试、构建脚本、包里用不到的派生清单都不打进去；README/LICENSE 留着方便别人看
EXCLUDES=(-x 'test/*' 'node_modules/*' 'dist/*' 'tools/*' 'docs/*' '.git/*' '.DS_Store' 'manifest.chrome.json')

# ---- Firefox：manifest.json 本身 ----
(cd "$ROOT" && zip -qr "$OUT/marknote-firefox.zip" . "${EXCLUDES[@]}")

# ---- Chrome：换成派生出来的清单 ----
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd "$ROOT" && zip -qr "$TMP/src.zip" . "${EXCLUDES[@]}")
(cd "$TMP" && unzip -qo src.zip -d pkg && rm -f src.zip)
python3 "$ROOT/tools/make-chrome-manifest.py" > "$TMP/pkg/manifest.json"
(cd "$TMP/pkg" && zip -qr "$OUT/marknote-chrome.zip" .)

# ---- 再解一份出来：Firefox 的「临时载入附加组件」要选目录里的 manifest.json ----
rm -rf "$OUT/firefox-unpacked"
mkdir -p "$OUT/firefox-unpacked"
(cd "$OUT/firefox-unpacked" && unzip -qo "$OUT/marknote-firefox.zip")

ls -lh "$OUT"
echo
echo "Firefox：解压 marknote-firefox.zip → about:debugging#/runtime/this-firefox → 临时载入附加组件 → 选 manifest.json"
echo "Chrome ：解压 marknote-chrome.zip  → chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序"
echo "持久安装：./tools/sign-firefox.sh 走 AMO 自助签名，签完得到可直接安装的 .xpi（见 docs/amo-self-signing-steps.md）"
