#!/usr/bin/env bash
# 装眼镜端语音转写后端：whisper.cpp + ggml 模型 → ~/.bolloon/asr/
#
# 为什么在节点侧而不在眼镜上：Rokid Glasses（YodaOS-Sprite/AOSP）没有可用的系统 ASR
# （android.speech 的 RecognitionService 不存在；Rokid 的 AIUIService 是 signature 权限，
#  第三方应用绑定不了），所以眼镜只录音，转写由 bolloon 节点的 /api/asr 完成。
#
# 用法:
#   scripts/setup-asr.sh                 # 默认 ggml-base（~142MB，中文够用、CPU 快）
#   scripts/setup-asr.sh small           # 更准更慢（~466MB）
#   BOLLOON_ASR_DIR=/path scripts/setup-asr.sh
#
# 完成后节点默认就能用：BOLLOON_ASR_BIN / BOLLOON_ASR_MODEL 都可覆盖。
set -euo pipefail

MODEL_SIZE="${1:-base}"
DEST="${BOLLOON_ASR_DIR:-$HOME/.bolloon/asr}"
WORK="${WORK:-$HOME/.hermes/cache/scratch}"
SRC="$WORK/whisper.cpp"

mkdir -p "$DEST/bin" "$DEST/models"

# 1) cmake（macOS 免 brew：直接取官方预编译包）
if ! command -v cmake >/dev/null 2>&1 && [ ! -x "$WORK/cmake-bin/CMake.app/Contents/bin/cmake" ]; then
  echo "==> 下载 cmake"
  url=$(curl -s https://api.github.com/repos/Kitware/CMake/releases/latest \
        | grep -oE 'https://[^"]*macos-universal\.tar\.gz' | head -1)
  [ -n "$url" ] || { echo "!! 拿不到 cmake 下载地址" >&2; exit 1; }
  mkdir -p "$WORK/cmake-pkg" && curl -fL --connect-timeout 20 -o "$WORK/cmake-pkg/cmake.tgz" "$url"
  tar xzf "$WORK/cmake-pkg/cmake.tgz" -C "$WORK/cmake-pkg"
  mkdir -p "$WORK/cmake-bin"
  cp -R "$WORK/cmake-pkg"/cmake-*/CMake.app "$WORK/cmake-bin/"
fi
export PATH="$WORK/cmake-bin/CMake.app/Contents/bin:$PATH"

# 2) whisper.cpp
if [ ! -d "$SRC/.git" ]; then
  echo "==> clone whisper.cpp"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi
echo "==> 编译 whisper.cpp (CPU)"
cd "$SRC"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" --config Release

# 3) 二进制 + dylib 一起拷（whisper-cli 通过 @loader_path 找 dylib）
echo "==> 安装到 $DEST/bin"
cp build/bin/whisper-cli "$DEST/bin/" 2>/dev/null || cp build/bin/main "$DEST/bin/whisper-cli"
cp build/bin/*.dylib "$DEST/bin/" 2>/dev/null || true

# 4) 模型
MODEL="$DEST/models/ggml-$MODEL_SIZE.bin"
if [ ! -f "$MODEL" ]; then
  echo "==> 下载模型 $MODEL_SIZE"
  bash models/download-ggml-model.sh "$MODEL_SIZE"
  cp "models/ggml-$MODEL_SIZE.bin" "$MODEL"
fi

echo
echo "==> 完成"
echo "    bin:   $DEST/bin/whisper-cli"
echo "    model: $MODEL"
echo "    自检:  $DEST/bin/whisper-cli -m $MODEL -f <某个16k.wav> -l zh -nt -np"
