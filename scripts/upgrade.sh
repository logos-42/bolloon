#!/usr/bin/env bash
# bolloon-version: 0.3.6
# 升级 Bolloon Agent 到最新版本。
# bolloon 通过 npm 全局分发，因此升级即 `npm install -g`。
set -euo pipefail

echo "🔄 升级 Bolloon Agent 到最新版本..."

if npm install -g @bolloon/bolloon-agent@latest; then
  echo "✅ 升级完成。"
  echo "💡 请重新运行 bolloon 以使用新版本。"
else
  echo "❌ 升级失败。若提示权限不足，请尝试加 sudo 或检查 npm 全局目录权限："
  echo "   sudo npm install -g @bolloon/bolloon-agent@latest"
  exit 1
fi
