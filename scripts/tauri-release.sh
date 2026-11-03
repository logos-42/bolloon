#!/usr/bin/env bash
# tauri-release.sh — App 发布一条龙 (2026-11-04: 换钥后重立发布纪律)
#
# 为什么有这个脚本: 0.7.3–0.7.5 三次发布都没有 `.sig` / 清单停在 0.7.0-1,
# 直到要更新时才发现"链断了"。发布不该靠记忆, 应该靠脚本里的门。
#
# 用法:
#   bash scripts/tauri-release.sh --check          # 只做发布前自检 (不构建)
#   bash scripts/tauri-release.sh                  # 自检 → 构建 → 生成清单 → 验签
#   BASE_URL=https://bolloon.cn/update bash scripts/tauri-release.sh
#
# 退出码: 0 = 全链路通过; 非 0 = 卡在哪一步会直接打印原因
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/rust/app-tauri"
CONF="$SRC/src-tauri/tauri.conf.json"
KEYDIR="$SRC/src-tauri/.tauri"
KEY="$KEYDIR/updater.key"
PASSFILE="$KEYDIR/updater.password"
PUBFILE="$KEYDIR/updater.key.pub"
BASE_URL="${BASE_URL:-https://bolloon.cn/update}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { red "✗ $*"; exit 1; }

echo "== 1/5 发布前自检 =="

# ① 密钥三件套 (换钥事故的根因就是这里断的)
[[ -f "$KEY" ]] || die "缺私钥 $KEY（签名必需；先找回或运行 tauri signer generate -w $KEY -p <密码>）"
[[ -f "$PASSFILE" ]] || die "缺口令 $PASSFILE"
[[ -f "$PUBFILE" ]] || die "缺公钥 $PUBFILE"
PERM=$(stat -f '%Lp' "$KEY")
[[ "$PERM" == "600" ]] || yellow "⚠ 私钥权限是 $PERM，应为 600"
green "✓ 密钥三件套齐全（私钥 $(wc -c < "$KEY" | tr -d ' ')B / 口令 $(wc -c < "$PASSFILE" | tr -d ' ')B）"

# ② 公钥一致 (conf 里那份必须就是这把私钥的公钥)
python3 - "$CONF" "$PUBFILE" <<'PY'
import base64, json, sys
conf_pub = json.load(open(sys.argv[1]))['plugins']['updater']['pubkey'].strip()
file_pub = open(sys.argv[2]).read().strip()
if conf_pub != file_pub:
    print('✗ tauri.conf.json 的 pubkey 与 .tauri/updater.key.pub 不一致 —— 客户端会验签失败')
    sys.exit(1)
ident = base64.b64decode(conf_pub).decode().splitlines()[0]
print(f'✓ 公钥一致：{ident}')
PY

# ③ 版本一致 (四处必须同一个号)
VER_CONF=$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")
VER_NPM=$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")
VER_RS=$(grep -m1 '^version' "$ROOT/rust/Cargo.toml" | cut -d'"' -f2)
VER_TAURI=$(grep -m1 '^version' "$SRC/src-tauri/Cargo.toml" | cut -d'"' -f2)
# App/npm 允许四段版本 (如 0.7.7.1); Cargo 只能三段 ⇒ 校验"前缀一致"即可
if [[ "$VER_CONF" != "$VER_NPM" ]]; then
  die "app 版本不一致: conf=$VER_CONF npm=$VER_NPM"
fi
for v in "$VER_RS" "$VER_TAURI"; do
  case "$VER_CONF" in
    "$v"|"$v".*) ;;
    *) die "Cargo 版本 $v 与 App 版本 $VER_CONF 对不上" ;;
  esac
done
green "✓ 版本一致：$VER_CONF"

[[ "$CHECK_ONLY" == "1" ]] && { green "自检通过（--check 模式，不构建）"; exit 0; }

echo "== 2/5 构建 (tauri build) =="
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  yellow "⊘ SKIP_BUILD=1：跳过构建，直接收集已有产物"
  BUNDLE_READY=1
fi
TAURI_BIN="${TAURI_BIN:-/tmp/tauri-cli/node_modules/.bin/tauri}"
[[ -x "$TAURI_BIN" ]] || TAURI_BIN="$(command -v tauri || true)"
[[ -n "$TAURI_BIN" && -x "$TAURI_BIN" ]] || die "找不到 tauri CLI（装到 /tmp/tauri-cli 或设 TAURI_BIN）"

if [[ "${BUNDLE_READY:-0}" != "1" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASSFILE")"
  ( cd "$SRC" && "$TAURI_BIN" build )
fi

echo "== 3/5 收集产物 =="
BUNDLE="$SRC/src-tauri/target/release/bundle"
mapfile -t PKGS < <(find "$BUNDLE" -name '*.app.tar.gz' -o -name '*.nsis.zip' -o -name '*.AppImage.tar.gz' 2>/dev/null)
[[ ${#PKGS[@]} -gt 0 ]] || die "没找到可更新的产物 (*.app.tar.gz 等) —— 检查 bundle.createUpdaterArtifacts=true"
for p in "${PKGS[@]}"; do
  [[ -f "$p.sig" ]] || die "产物缺签名: $p.sig（这就是 0.7.3–0.7.5 的症状）"
  green "✓ $(basename "$p")  +  .sig $(wc -c < "$p.sig" | tr -d ' ')B"
done

echo "== 4/5 生成清单 =="
OUT_DIR="${OUT_DIR:-$ROOT/release/update}"
mkdir -p "$OUT_DIR"
npx tsx "$ROOT/scripts/gen-update-manifest.ts" \
  --bundle-dir "$BUNDLE" \
  --version "$VER_CONF" \
  --notes "${NOTES:-$VER_CONF 换签名密钥版本}" \
  --base-url "$BASE_URL" \
  --out "$OUT_DIR/latest.json"

echo "== 5/5 本地真验签 (客户端那一刻会发生的事) =="
PUB=$(python3 -c "import json;print(json.load(open('$CONF'))['plugins']['updater']['pubkey'])")
# 关键: 本地阶段必须验**本地刚构建的包**, 不能验线上 URL (线上还是旧包, 会假红)
if [[ ${#PKGS[@]} -eq 1 ]]; then
  node "$ROOT/scripts/verify-updater-signature.mjs" --manifest "$OUT_DIR/latest.json" --pubkey "$PUB" --file "${PKGS[0]}"
else
  node "$ROOT/scripts/verify-updater-signature.mjs" --manifest "$OUT_DIR/latest.json" --pubkey "$PUB"
fi

echo
green "全链路通过。产物清单：$OUT_DIR/latest.json"
yellow "别忘了："
yellow "  1) 把 latest.json 与产物上传到 $BASE_URL（路径要与清单里的 url 一致）"
yellow "  2) 部署后再验一次线上：node scripts/verify-updater-signature.mjs --manifest $BASE_URL/latest.json --pubkey <pubkey>"
yellow "  3) 换钥发布 ⇒ 已装旧版(≤0.7.5)客户端无法自动升级，需要手动重装一次"
