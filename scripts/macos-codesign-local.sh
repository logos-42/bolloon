#!/usr/bin/env bash
# macos-codesign-local.sh — 给 Bolloon 一个**稳定的**本地代码签名身份
#
# 为什么需要它 (2026-11-05, leo: 「已经允许的 Mac 系统弹窗反复出现」):
#   tccd 日志里 responsible 进程的 identifier 是 `<ID of InvalidCode>`,
#   并且 "Failed to copy signing info ... -67062" —— 因为 .app **完全没签名**。
#   macOS TCC 靠代码签名来记住「这个 App 已经被允许访问 桌面/文稿/下载」;
#   没有签名就没有可记住的身份, 于是每次访问都会**再问一次**。
#   临时 ad-hoc 签名 (`codesign -s -`) 也不行: 它的 designated requirement 是
#   cdhash, 每次重新构建都变 ⇒ 每次 rebuild 后又问一遍。
#   自签证书的 requirement 是「identifier + 证书叶哈希」, 跨构建稳定 ⇒
#   允许一次, 之后一直有效。
#
# 用法:
#   bash scripts/macos-codesign-local.sh identity     # 幂等: 没有就建自签身份
#   bash scripts/macos-codesign-local.sh sign <path>  # 给 .app / 二进制签名
#   bash scripts/macos-codesign-local.sh verify <path>
#   bash scripts/macos-codesign-local.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/rust/app-tauri/src-tauri/.tauri/codesign"
KEY="$DIR/local.key"
CRT="$DIR/local.crt"
P12="$DIR/local.p12"
PASSFILE="$DIR/local.password"
IDENTITY_NAME="Bolloon Local Code Signing"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { red "✗ $*"; exit 1; }

has_identity() {
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY_NAME"
}

cmd_identity() {
  mkdir -p "$DIR"
  chmod 700 "$DIR"
  if has_identity; then
    green "✓ 身份已存在: $IDENTITY_NAME"
    return 0
  fi
  if [[ ! -f "$KEY" || ! -f "$CRT" ]]; then
    echo "· 生成自签代码签名证书 (10 年, EKU=codeSigning)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$KEY" -out "$CRT" \
      -subj "/CN=$IDENTITY_NAME/O=Bolloon/C=CN" \
      -addext "basicConstraints=critical,CA:false" \
      -addext "keyUsage=critical,digitalSignature" \
      -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1
  fi
  [[ -f "$PASSFILE" ]] || openssl rand -hex 16 > "$PASSFILE"
  chmod 600 "$KEY" "$PASSFILE"

  openssl pkcs12 -export -inkey "$KEY" -in "$CRT" -out "$P12" \
    -name "$IDENTITY_NAME" -passout "file:$PASSFILE" >/dev/null 2>&1

  # -T /usr/bin/codesign: 允许 codesign 读私钥, 避免每次签名弹钥匙串框
  security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$(cat "$PASSFILE")" -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null
  rm -f "$P12"

  # 自签证书必须被本机信任, 否则 `find-identity -v` 看不见它 (codesign 也不认)
  # -r trustRoot: 以它自己为根; -p codeSign: 只信代码签名用途 (不留别的口子)
  security add-trusted-cert -r trustRoot -p codeSign \
    -k "$HOME/Library/Keychains/login.keychain-db" "$CRT" >/dev/null 2>&1 || true

  has_identity || die "导入后仍找不到身份 (钥匙串被锁? 试 security unlock-keychain)"
  green "✓ 已创建并导入: $IDENTITY_NAME"
}

do_sign() {
  local p="$1"
  [[ -e "$p" ]] || die "路径不存在: $p"
  # 不加 --options runtime: 本地自签不公证, hardened runtime 只会徒增限制
  codesign --force --deep --timestamp=none --sign "$IDENTITY_NAME" "$p"
}

cmd_sign() {
  has_identity || cmd_identity 1>&2
  for p in "$@"; do
    echo "· 签名 $p"
    do_sign "$p"
  done
}

cmd_verify() {
  local bad=0
  for p in "$@"; do
    echo "── $p"
    codesign --verify --strict --verbose=2 "$p" 2>&1 | sed 's/^/  /' || bad=1
    local req; req="$(codesign -d -r- "$p" 2>&1 | grep -E 'designated =>' || true)"
    echo "  $req"
    if grep -q 'cdhash' <<< "$req"; then
      yellow "  ⚠ requirement 是 cdhash ⇒ 重新构建后 TCC 会再问一次"
    fi
  done
  return $bad
}

cmd_status() {
  echo "身份:"; security find-identity -v -p codesigning 2>/dev/null | sed 's/^/  /'
  for p in \
    "$ROOT/rust/app-tauri/src-tauri/target/release/bundle/macos/Bolloon.app" \
    "$ROOT/rust/app-tauri/src-tauri/target/debug/bundle/macos/Bolloon.app" \
    "/Applications/Bolloon.app"; do
    [[ -e "$p" ]] || continue
    if codesign --verify "$p" >/dev/null 2>&1; then
      echo "  ✓ $(codesign -dv --verbose=2 "$p" 2>&1 | grep -m1 '^Authority=' | sed 's/^Authority=//')  ← $p"
    else
      echo "  ✗ 未签名 ← $p"
    fi
  done
}

case "${1:-status}" in
  identity) cmd_identity ;;
  sign) shift; [[ $# -gt 0 ]] || die "用法: sign <path> [...]"; cmd_sign "$@" ;;
  verify) shift; [[ $# -gt 0 ]] || die "用法: verify <path> [...]"; cmd_verify "$@" ;;
  status) cmd_status ;;
  *) die "未知子命令: $1 (identity|sign|verify|status)" ;;
esac
