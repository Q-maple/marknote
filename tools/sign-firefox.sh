#!/usr/bin/env bash
#
# 走 AMO 自助签名（unlisted / 自己分发），把 MarkNote 签成能持久安装的 .xpi。
#
# 用法（推荐：密钥从环境变量给，脚本不落盘）：
#   WEB_EXT_API_KEY='user:12345:67' WEB_EXT_API_SECRET='xxxxxx' ./tools/sign-firefox.sh
#
# 也可以直接跑，脚本会交互式问你（输入不回显，不写入任何文件）：
#   ./tools/sign-firefox.sh
#
# 密钥在这里免费申请：https://addons.mozilla.org/developers/addon/api/key/
#   - JWT issuer key  → 形如 user:12345:67
#   - JWT secret      → 一串十六进制
#
# 签名成功后在 dist/signed/ 里得到签名版 .xpi，双击即可持久安装。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/firefox-unpacked"
OUT="$ROOT/dist/signed"

# web-ext 自己就跑在 node 上，所以 node 一定在；顺手把它的升级检查提示关掉，免得刷屏
export NO_UPDATE_NOTIFIER=1
command -v node >/dev/null 2>&1 || { echo "✗ 需要 node（web-ext 依赖它）" >&2; exit 1; }
json_field() { node -e 'const m=require(process.argv[1]);process.stdout.write(String(eval("m."+process.argv[2])))' "$1" "$2"; }

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 1. 准备要签名的目录 ----------
# AMO 拿到的是"扩展目录的内容"，manifest.json 必须在根上。
if [ ! -f "$SRC/manifest.json" ]; then
  say "· dist/firefox-unpacked 不在，先跑一次打包"
  "$ROOT/tools/build.sh" >/dev/null
fi
[ -f "$SRC/manifest.json" ] || die "找不到 $SRC/manifest.json"

VERSION="$(json_field "$SRC/manifest.json" version)"
EXT_ID="$(json_field "$SRC/manifest.json" browser_specific_settings.gecko.id)"
say "· 准备签名：$EXT_ID  v$VERSION"

# ---------- 2. 找 web-ext ----------
if command -v web-ext >/dev/null 2>&1; then
  WEBEXT=(web-ext)
elif command -v node >/dev/null 2>&1; then
  say "· 本机没有 web-ext，改用 npx（首次会下载几十秒）"
  WEBEXT=(npx --yes web-ext)
else
  die "需要 node（用 npx 跑 web-ext）或全局安装 web-ext：npm i -g web-ext"
fi

# web-ext 本身能不能跑起来，和"代码有没有 error"是两件事，分开报。
if ! WEBEXT_VERSION="$("${WEBEXT[@]}" --version 2>&1)"; then
  printf '%s\n' "$WEBEXT_VERSION" | tail -3 >&2
  die "web-ext 跑不起来（上一行是它的原话）。常见原因：npm 缓存目录没权限（sudo chown -R \$(id -u) ~/.npm），或网络装不上"
fi
say "· web-ext $WEBEXT_VERSION"

# ---------- 3. 本地自检（有 error 就别浪费往返） ----------
say "· 本地校验中…"
set +e
LINT_OUT="$("${WEBEXT[@]}" lint --source-dir "$SRC" --output json 2>/dev/null)"
set -e
LINT_COUNT="$(printf '%s' "$LINT_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const e=j.errors||[];process.stdout.write(String(e.length));e.forEach(x=>console.error("    error: "+(x.message||"")+" ("+(x.file||"")+")"))}catch(err){process.stdout.write("?")}})' 2>/dev/null)"
case "$LINT_COUNT" in
  0) say "  ✓ 0 errors（warning 不影响签名）" ;;
  ''|'?') say "  校验结果读不出来，继续尝试签名" ;;
  *) die "校验有 $LINT_COUNT 个 error，先修掉再来签名" ;;
esac

# ---------- 4. 取密钥（不落盘、不走命令行参数，避免出现在 ps 里） ----------
if [ -z "${WEB_EXT_API_KEY:-}" ]; then
  read -r -p "AMO JWT issuer key（形如 user:12345:67）: " WEB_EXT_API_KEY || true
fi
if [ -z "${WEB_EXT_API_SECRET:-}" ]; then
  read -rs -p "AMO JWT secret: " WEB_EXT_API_SECRET || true
  echo
fi
[ -n "${WEB_EXT_API_KEY:-}" ] || die "缺少 API key（见 https://addons.mozilla.org/developers/addon/api/key/）"
[ -n "${WEB_EXT_API_SECRET:-}" ] || die "缺少 API secret"
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

# ---------- 5. 提交签名 ----------
mkdir -p "$OUT"
say "· 提交给 AMO 签名（unlisted，不走人工审核队列）…"
# 说明：--channel=unlisted 才是"自己分发"；不传密钥参数，web-ext 会读 WEB_EXT_API_* 环境变量。
if ! "${WEBEXT[@]}" sign \
      --channel=unlisted \
      --source-dir "$SRC" \
      --artifacts-dir "$OUT"; then
  cat <<'EOF' >&2

签名没成功。常见原因：
  · 401/Unauthorized —— API key 或 secret 抄错了（注意别把 issuer 和 secret 弄反）
  · 409/Conflict     —— 这个版本号已经签过了；改 manifest.json 里的 version 再来
  · 超时              —— 包本身通常已经签好了，去 AMO → 我的附加组件 → 该版本 → 右键保存签名副本
EOF
  exit 1
fi

# ---------- 6. 报告结果 ----------
XPI="$(ls -t "$OUT"/*.xpi 2>/dev/null | head -1 || true)"
echo
if [ -n "$XPI" ]; then
  say "✓ 签名完成：$XPI"
  cat <<EOF

下一步：
  1. 双击上面这个 .xpi（或 about:addons → 右上角齿轮 → 从文件安装附加组件）
  2. about:debugging#/runtime/this-firefox → 把临时载入的 MarkNote「移除」，避免两个版本打架
  3. 完全退出 Firefox 再打开，about:addons 里看到 v$VERSION 就是持久安装成功了
EOF
else
  say "✓ 已提交，但没在 $OUT 里看到 .xpi"
  echo "去 AMO → 我的附加组件 → 该版本 → 右键文件链接「另存为」拿签名副本。"
fi
