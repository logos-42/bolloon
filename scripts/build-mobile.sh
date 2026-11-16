#!/usr/bin/env bash
# build-mobile.sh — Bolloon 手机端 (Tauri v2) 构建脚本
#
# 架构（与桌面同源）：
#   Rust 壳启动内嵌 axum 服务 → WebView 导航到 http://127.0.0.1:<port>/?app=mobile
#   → 复用同一份 index.html（body.mobile 响应式 + 底部四 tab）。
#   因此不需要 Capacitor 的 dist/ios、dist/web 静态同步。
#
# 用法:
#   bash scripts/build-mobile.sh android          # 出 APK/AAB
#   bash scripts/build-mobile.sh ios              # 出 iOS 归档（需 macOS + Xcode）
#   bash scripts/build-mobile.sh all              # 先 android 再 ios
#   bash scripts/build-mobile.sh --check           # 只做环境自检
#
# 前提:
#   - Rust: rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
#   - Android: ANDROID_HOME / ANDROID_SDK_ROOT + NDK（Tauri 需要 NDK 26+）
#   - iOS: 完整 Xcode（不是 Command Line Tools）+ CocoaPods
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT/rust/app-tauri/src-tauri"
TARGET="${1:-all}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && { CHECK_ONLY=1; TARGET=all; }

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { red "✗ $*"; exit 1; }

echo "[build-mobile] root=$ROOT target=$TARGET"

# ── 0. 自检 ───────────────────────────────────────────────
ANDROID_OK=0
IOS_OK=0

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -n "$SDK" && -d "$SDK" ]]; then
  if [[ -d "$SDK/ndk" ]]; then ANDROID_OK=1; else yellow "⚠ Android SDK 有，但缺 NDK（$SDK/ndk）"; fi
else
  yellow "⚠ 未设置 ANDROID_HOME / ANDROID_SDK_ROOT"
fi
command -v cargo >/dev/null || die "缺 cargo"
if rustup target list --installed 2>/dev/null | grep -q 'aarch64-linux-android'; then
  :
else
  yellow "⚠ 未安装 android rust target（rustup target add aarch64-linux-android ...）"
  [[ "$ANDROID_OK" == "1" ]] && ANDROID_OK=0
fi

if [[ "$(uname -s)" == "Darwin" ]] && xcodebuild -version >/dev/null 2>&1; then
  IOS_OK=1
else
  yellow "⚠ iOS 需要完整 Xcode（当前 xcodebuild 不可用，只有 Command Line Tools 不够）"
fi

[[ "$ANDROID_OK" == "1" ]] && green "✓ Android 环境就绪" || yellow "⊘ Android 环境未就绪"
[[ "$IOS_OK" == "1" ]] && green "✓ iOS 环境就绪" || yellow "⊘ iOS 环境未就绪"

if [[ "$CHECK_ONLY" == "1" ]]; then
  [[ "$ANDROID_OK" == "1" || "$IOS_OK" == "1" ]] || die "两端环境都不就绪"
  exit 0
fi

# ── 1. 首次初始化（生成 gen/android、gen/apple）────────────
init_target() {
  local t="$1"
  if [[ ! -d "$TAURI_DIR/gen" ]]; then
    echo "[build-mobile] 首次初始化 $t…"
    ( cd "$TAURI_DIR" && cargo tauri "$t" init )
  fi
}

# ── 2. 构建 ───────────────────────────────────────────────
build_android() {
  [[ "$ANDROID_OK" == "1" ]] || die "Android 环境未就绪：设 ANDROID_HOME + 装 NDK + rustup android target"
  init_target android
  echo "[build-mobile] Android build…"
  ( cd "$TAURI_DIR" && cargo tauri android build )
  green "✓ Android 产物：$TAURI_DIR/gen/android/app/build/outputs/apk/"
}

build_ios() {
  [[ "$IOS_OK" == "1" ]] || die "iOS 环境未就绪：需完整 Xcode + CocoaPods（本机当前只有 Command Line Tools）"
  init_target ios
  echo "[build-mobile] iOS build…"
  ( cd "$TAURI_DIR" && cargo tauri ios build )
  green "✓ iOS 产物：$TAURI_DIR/gen/apple/build/"
}

case "$TARGET" in
  android) build_android ;;
  ios) build_ios ;;
  all)
    build_android
    if [[ "$IOS_OK" == "1" ]]; then build_ios; else yellow "⊘ 跳过 iOS（环境未就绪）"; fi
    ;;
  *) die "未知目标: $TARGET（android|ios|all|--check）" ;;
esac

green "[build-mobile] 完成"
