#!/usr/bin/env bash
# scripts/build-mobile.sh — Bolloon 手机端 (Tauri) 构建脚本
#
# 用法:
#   ./scripts/build-mobile.sh android    # 只打 Android APK/AAB
#   ./scripts/build-mobile.sh ios        # 只打 iOS IPA (需 macOS + Xcode)
#   ./scripts/build-mobile.sh all        # 先打 android，再尝试 ios
#
# 前提:
#   - Rust toolchain 已安装 (cargo, rustc)
#   - Android: ANDROID_SDK_ROOT / ANDROID_HOME 已设置，已接受 SDK 许可
#   - iOS:   macOS + Xcode + Xcode 命令行工具
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT/rust/app-tauri/src-tauri"
TARGET="${1:-all}"

echo "[build-mobile] 项目根目录: $ROOT"
echo "[build-mobile] Tauri 目录: $TAURI_DIR"
echo "[build-mobile] 构建目标: $TARGET"

# 0. 确保前端资源已构建 (dist/web/ 包含 mobile.html / mobile.css / mobile.js)
if [ ! -f "$ROOT/dist/web/mobile.html" ]; then
  echo "[build-mobile] dist/web/mobile.html 不存在，先运行 build:web…"
  npx tsx "$ROOT/scripts/build-web.ts"
fi

# 1. 构建 Rust 内嵌服务 (release)
echo "[build-mobile] cargo build --release (bolloon-tauri)…"
cargo build --release --manifest-path "$TAURI_DIR/Cargo.toml"

# 2. Tauri 移动端初始化 (首次需要)
if [ "$TARGET" = "android" ] || [ "$TARGET" = "all" ]; then
  echo "[build-mobile] cargo tauri android init…"
  (cd "$TAURI_DIR" && cargo tauri android init 2>/dev/null || true)
fi

if [ "$TARGET" = "ios" ] || [ "$TARGET" = "all" ]; then
  echo "[build-mobile] cargo tauri ios init…"
  (cd "$TAURI_DIR" && cargo tauri ios init 2>/dev/null || true)
fi

# 3. Tauri 打包
if [ "$TARGET" = "android" ] || [ "$TARGET" = "all" ]; then
  echo "[build-mobile] 构建 Android 包…"
  (cd "$TAURI_DIR" && cargo tauri build --target android)
  echo "[build-mobile] Android 包构建完成，产物在 $TAURI_DIR/gen/target/release/bundle/"
fi

if [ "$TARGET" = "ios" ] || [ "$TARGET" = "all" ]; then
  echo "[build-mobile] 构建 iOS 包… (需 macOS + Xcode)"
  (cd "$TAURI_DIR" && cargo tauri build --target ios)
  echo "[build-mobile] iOS 包构建完成，产物在 $TAURI_DIR/gen/target/release/bundle/"
fi

echo "[build-mobile] 完成!"
