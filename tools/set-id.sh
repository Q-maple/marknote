#!/usr/bin/env bash
#
# 换掉扩展 ID（browser_specific_settings.gecko.id），并重新打包。
#
# 什么时候需要它：AMO 报「发现重复的附加组件 ID」，而且在
# https://addons.mozilla.org/zh-CN/developers/addons 里**没有**这个包
# —— 说明这个 ID 被别的账号占了，只能换一个。
#
#   ./tools/set-id.sh marknote-a1b2c3@webext.local
#
# 注意：ID 一变，Firefox 就认为这是**另一个扩展**，原来存的划线不会自动跟过来。
# 换之前先在旧版里「管理 / 导出 → 导出 JSON 备份」，装上新 ID 的版本后再导入。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.json"
NEW_ID="${1:-}"

if [ -z "$NEW_ID" ]; then
  OLD="$(node -e 'process.stdout.write(require(process.argv[1]).browser_specific_settings.gecko.id)' "$MANIFEST")"
  echo "当前 ID：$OLD"
  echo "用法：$0 <新的扩展 ID>"
  echo
  echo "新 ID 要长得像邮箱，并且在 AMO 上没人用过。想省事就用一个随机后缀："
  echo "  $0 marknote-$(openssl rand -hex 4 2>/dev/null || echo a1b2c3d4)@webext.local"
  exit 2
fi

# 基本的形状检查：AMO 要求像 email 的格式
case "$NEW_ID" in
  *@*.*) ;;
  *) echo "✗ ID 要写成 email 的样子，例如 marknote-a1b2c3@webext.local" >&2; exit 1 ;;
esac

OLD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).browser_specific_settings.gecko.id)' "$MANIFEST")"
if [ "$OLD_ID" = "$NEW_ID" ]; then
  echo "· ID 没变（还是 ${OLD_ID}），什么都不用做"
  exit 0
fi

# 只替换这一行的值，保持文件其余部分（缩进、注释顺序）原样
node -e '
const fs = require("fs");
const [file, oldId, newId] = process.argv.slice(1);
const src = fs.readFileSync(file, "utf8");
if (!src.includes(JSON.stringify(oldId))) { console.error("✗ 在清单里找不到 " + oldId); process.exit(1); }
fs.writeFileSync(file, src.replace(JSON.stringify(oldId), JSON.stringify(newId)));
' "$MANIFEST" "$OLD_ID" "$NEW_ID"

# 确认改完仍然是一份合法清单
node -e 'const m=require(process.argv[1]);process.exit(m.browser_specific_settings.gecko.id===process.argv[2]?0:1)' "$MANIFEST" "$NEW_ID" \
  || { echo "✗ 改动后清单不合法，已中止" >&2; exit 1; }

echo "✓ 扩展 ID：$OLD_ID  →  $NEW_ID"
"$ROOT/tools/build.sh" >/dev/null
echo "✓ 已重新打包：dist/marknote-firefox.zip"
cat <<EOF

接下来：
  1. 去 AMO 重新「提交新附加组件」→ 仍然选 On your own → 上传上面这个 zip
  2. 装上新 ID 的版本后，去「管理 / 导出 → 导入 JSON 备份」把划线导回来
     （ID 变了就等于另一个扩展，旧数据不会自动跟过来）
  3. 旧的临时载入记得在 about:debugging 里移除
EOF
