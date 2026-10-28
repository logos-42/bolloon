#!/usr/bin/env bash
# 把 Rust bolloon 交叉编译到 Rokid Glasses (arm64 Android)
#
# 用法:
#   scripts/build-android-rust.sh            # 编译 + 拷贝到 jniLibs
#   scripts/build-android-rust.sh --push     # 编译后再 adb push 到 /data/local/tmp
#
# 前置:
#   - NDK (默认 ~/Downloads/android-ndk-r27c, 可用 NDK_DIR 覆盖)
#   - rustup target add aarch64-linux-android
#   - adb (默认 ~/Downloads/platform-tools/adb, 可用 ADB 覆盖)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NDK_DIR="${NDK_DIR:-$HOME/Downloads/android-ndk-r27c}"
ADB="${ADB:-$HOME/Downloads/platform-tools/adb}"

TARGET=aarch64-linux-android
API="${ANDROID_API:-26}"          # Rokid Glasses = Android 14 / SDK 34, 用 26 打底兼容
HOST_TAG=darwin-x86_64
TOOLCHAIN="$NDK_DIR/toolchains/llvm/prebuilt/$HOST_TAG"

if [ ! -d "$TOOLCHAIN" ]; then
  echo "!! 找不到 NDK toolchain: $TOOLCHAIN" >&2
  echo "   设置 NDK_DIR=/path/to/android-ndk-rXX 后重试" >&2
  exit 1
fi

CLANG="$TOOLCHAIN/bin/${TARGET}${API}-clang"
if [ ! -x "$CLANG" ]; then
  echo "!! 找不到 clang: $CLANG" >&2
  exit 1
fi

export CC_${TARGET//-/_}="$CLANG"
export CXX_${TARGET//-/_}="${TOOLCHAIN}/bin/${TARGET}${API}-clang++"
export AR_${TARGET//-/_}="${TOOLCHAIN}/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CLANG"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="${TOOLCHAIN}/bin/llvm-ar"
# ring / libsqlite3-sys 走 NDK clang + NDK 自带的 sysroot
export CFLAGS_aarch64_linux_android="--sysroot=$TOOLCHAIN/sysroot"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$TOOLCHAIN/sysroot"

cd "$ROOT/rust"
echo "==> cargo build -p bolloon-cli --release --target $TARGET"
cargo build -p bolloon-cli --release --target "$TARGET"

BIN="$ROOT/rust/target/$TARGET/release/bolloon"
if [ ! -f "$BIN" ]; then
  echo "!! 编译产物缺失: $BIN" >&2
  exit 1
fi

OUT_DIR="$ROOT/rokid/glass/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$OUT_DIR"
cp "$BIN" "$OUT_DIR/libbolloon_node.so"
echo "==> 已拷贝: $OUT_DIR/libbolloon_node.so ($(du -h "$BIN" | cut -f1))"

if [ "${1:-}" = "--push" ]; then
  "$ADB" push "$BIN" /data/local/tmp/bolloon
  "$ADB" shell chmod 755 /data/local/tmp/bolloon
  echo "==> 已推送: /data/local/tmp/bolloon"
  "$ADB" shell "/data/local/tmp/bolloon --version || /data/local/tmp/bolloon status || true"
fi
