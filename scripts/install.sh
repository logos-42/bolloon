#!/usr/bin/env bash
# bolloon-version
# Bolloon Agent 安装脚本（从 GitHub 获取）
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/logos-42/bolloon/master/scripts/install.sh | sh
#
# 行为:
#   1. 从 GitHub Releases 取最新版本号
#   2. 下载对应平台的预编译包（bolloon-<plat>-<arch>.tar.gz）
#   3. 若 GitHub 未提供该平台包（或下载失败），回退到 npm install -g
#
# 环境变量:
#   BOLLOON_VERSION      指定版本（如 0.3.7），默认取最新 release
#   BOLLOON_INSTALL_DIR  安装目录，默认 /usr/local/bin

set -euo pipefail

REPO="logos-42/bolloon"
INSTALL_DIR="${BOLLOON_INSTALL_DIR:-/usr/local/bin}"
VERSION="${BOLLOON_VERSION:-}"

echo "🔄 安装 Bolloon Agent ..."

# 1. 解析最新版本（GitHub releases）
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
fi
VERSION="${VERSION#v}"
if [ -z "$VERSION" ]; then
  echo "⚠️  无法从 GitHub 解析版本，回退到 npm 最新版"
  VERSION="latest"
fi
echo "   版本: ${VERSION}"

# 2. 平台资产名
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  PLAT="linux"  ; EXT="tar.gz" ;;
  Darwin) PLAT="darwin" ; EXT="tar.gz" ;;
  *) echo "❌ 不支持的平台 $OS，请改用: npm install -g @bolloon/bolloon-agent"; exit 1 ;;
esac
ASSET="bolloon-${PLAT}-${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/v${VERSION}/$ASSET"

# 3. 尝试从 GitHub 下载预编译包
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

if [ "$VERSION" != "latest" ] && curl -fsSL "$URL" -o "$TMP/$ASSET" 2>/dev/null; then
  echo "   已从 GitHub 下载 $ASSET"
  tar -xzf "$TMP/$ASSET" -C "$TMP"

  # 安装到 INSTALL_DIR（不可写时自动加 sudo）
  if [ -w "$INSTALL_DIR" ]; then
    install -m 0755 "$TMP/bin/bolloon" "$INSTALL_DIR/bolloon" 2>/dev/null \
      || install -m 0755 "$TMP/bolloon" "$INSTALL_DIR/bolloon"
  else
    sudo install -m 0755 "$TMP/bin/bolloon" "$INSTALL_DIR/bolloon" 2>/dev/null \
      || sudo install -m 0755 "$TMP/bolloon" "$INSTALL_DIR/bolloon"
  fi
  echo "✅ 已安装到 $INSTALL_DIR/bolloon"
else
  echo "⚠️  GitHub 未提供 ${PLAT} 预编译包，回退到 npm 安装..."
  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ 未检测到 npm，请先安装 Node.js：https://nodejs.org"
    exit 1
  fi
  npm install -g "@bolloon/bolloon-agent@${VERSION}"
  echo "✅ 已通过 npm 安装 @bolloon/bolloon-agent@${VERSION}"
fi

echo "💡 验证: bolloon --version"
