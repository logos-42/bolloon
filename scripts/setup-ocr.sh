#!/usr/bin/env bash
# 编译眼镜「扫一眼」用的离线 OCR 助手（macOS Vision 框架，不需要任何 API key）
#
# 产物: ~/.bolloon/bin/vision-ocr
# 节点 /api/vision 默认就用这个路径（BOLLOON_OCR_BIN 可覆盖）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BOLLOON_BIN_DIR:-$HOME/.bolloon/bin}"
mkdir -p "$DEST"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "!! 需要 Xcode Command Line Tools 的 swiftc（xcode-select --install）" >&2
  exit 1
fi

echo "==> swiftc -O scripts/vision-ocr.swift"
swiftc -O "$ROOT/scripts/vision-ocr.swift" -o "$DEST/vision-ocr"
echo "==> 完成: $DEST/vision-ocr"
"$DEST/vision-ocr" 2>&1 | head -2 || true
