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

# ⓪ macOS 代码签名身份 (2026-11-04: 没有它构建会直接失败, 而且 TCC 记不住任何授权)
if [[ "$(uname -s)" == "Darwin" ]]; then
  # 缺身份就**自动建**(2026-11-04 leo: 别的电脑也会遇到, 要提前解决) —— build.rs 也会做同一件事,
  # 这里再兜一次, 保证发布机上一定有稳定身份 (ad-hoc 签名会让 TCC 每次重建都重问权限)
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "Bolloon Local Code Signing" \
    || bash "$ROOT/scripts/macos-codesign-local.sh" identity \
    || die "缺本地代码签名身份且自动创建失败: bash scripts/macos-codesign-local.sh identity 看原因"
  green "✓ 代码签名身份就绪 (Bolloon Local Code Signing)"
fi

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

# ③ 版本一致（2026-11-04 leo: **npm 与 App 各自独立编号**，app 0.7.9 / npm 0.7.6）
#    两条链各自自洽即可：
#      App 链 = tauri.conf ↔ tauri crate
#      npm 链 = package.json ↔ rust workspace (CLI 二进制在运行时自报 workspace 版本)
VER_CONF=$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")
VER_NPM=$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")
VER_RS=$(grep -m1 '^version' "$ROOT/rust/Cargo.toml" | cut -d'"' -f2)
VER_TAURI=$(grep -m1 '^version' "$SRC/src-tauri/Cargo.toml" | cut -d'"' -f2)
[[ "$VER_TAURI" == "$VER_CONF" ]] || die "tauri crate=$VER_TAURI 与 conf=$VER_CONF 不一致"
[[ "$VER_RS" == "$VER_NPM" ]] || die "rust workspace=$VER_RS 与 npm=$VER_NPM 不一致（CLI 自报版本必须等于 npm 版本）"
green "✓ 版本自洽：App $VER_CONF · npm $VER_NPM"

[[ "$CHECK_ONLY" == "1" ]] && { green "自检通过（--check 模式，不构建）"; exit 0; }

echo "== 2/5 构建 (tauri build) =="
# 2026-11-04: 上一轮 dmg 打包失败会在 /Volumes 留下挂着的 rw 镜像, 下次 bundle_dmg.sh
# 会因 "hdiutil: couldn't unmount - 资源忙" 再失败一次 —— 先清掉残留卷。
for vol in /Volumes/dmg.*; do
  [[ -d "$vol" ]] || continue
  dev="$(hdiutil info 2>/dev/null | awk -v v="$vol" '$0 ~ v {print $1}' | head -1)"
  [[ -n "$dev" ]] && hdiutil detach "$dev" -force >/dev/null 2>&1 || true
  yellow "⊘ 清掉残留挂载: $vol"
done
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  yellow "⊘ SKIP_BUILD=1：跳过构建，直接收集已有产物"
  BUNDLE_READY=1
fi
# 只在真要构建时才需要 tauri CLI —— SKIP_BUILD/BUNDLE_READY 收集已有产物不该被这步挡住
if [[ "${BUNDLE_READY:-0}" != "1" ]]; then
  TAURI_BIN="${TAURI_BIN:-/tmp/tauri-cli/node_modules/.bin/tauri}"
  [[ -x "$TAURI_BIN" ]] || TAURI_BIN="$(command -v tauri || command -v cargo-tauri || true)"
  [[ -n "$TAURI_BIN" && -x "$TAURI_BIN" ]] || die "找不到 tauri CLI（cargo tauri / npx @tauri-apps/cli，或设 TAURI_BIN）"
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASSFILE")"
  ( cd "$SRC" && "$TAURI_BIN" build )
fi

echo "== 2.5/5 代码签名门 (TCC 靠它记住「已允许」) =="
# 2026-11-05: .app 以前完全没签名, tccd 日志里 responsible 进程是 `<ID of InvalidCode>`
# 且每次访问 桌面/文稿/下载 都重新弹窗。签名身份由 `scripts/macos-codesign-local.sh identity`
# 建 (自签, requirement = identifier + 证书根哈希 ⇒ 跨重建稳定)。签在**打包前**才有效,
# 所以这里只做门 (fail-closed), 不做补签 —— 补签会让 .app.tar.gz 与包内 App 不一致。
APP_BUNDLE="$SRC/src-tauri/target/release/bundle/macos/Bolloon.app"
[[ -d "$APP_BUNDLE" ]] || die "没找到 $APP_BUNDLE"
codesign --verify --strict "$APP_BUNDLE" >/dev/null 2>&1 || die \
  ".app 未签名: tauri.conf.json 的 bundle.macOS.signingIdentity 没生效 (先跑 bash scripts/macos-codesign-local.sh identity 再重建)"
APP_REQ="$(codesign -d -r- "$APP_BUNDLE" 2>&1 | grep 'designated =>' || true)"
[[ -n "$APP_REQ" ]] || die "读不到 designated requirement: $APP_BUNDLE"
case "$APP_REQ" in
  *cdhash*) die "requirement 是 cdhash (ad-hoc 签名): 每次重建 macOS 都会重新问一遍权限 —— 用自签身份签" ;;
esac
green "✓ 稳定签名: $APP_REQ"

echo "== 3/5 收集产物 =="
BUNDLE="$SRC/src-tauri/target/release/bundle"
# macOS 自带 bash 3.2 没有 mapfile ⇒ 用可移植的读循环（2026-11-04 实测踩到）
PKGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && PKGS+=("$line")
done < <(find "$BUNDLE" -name '*.app.tar.gz' -o -name '*.nsis.zip' -o -name '*.AppImage.tar.gz' 2>/dev/null)
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
yellow "  1) 把 latest.json 与产物上传到 ${BASE_URL}（路径要与清单里的 url 一致）"
yellow "  2) 部署后再验一次线上：node scripts/verify-updater-signature.mjs --manifest ${BASE_URL}/latest.json --pubkey <pubkey>"
yellow "  3) 换钥发布 ⇒ 已装旧版(≤0.7.5)客户端无法自动升级，需要手动重装一次"
