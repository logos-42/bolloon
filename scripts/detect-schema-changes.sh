#!/bin/bash
# detect-schema-changes.sh — 阶段 C 护栏 6
#
# 检查 LLM 改的文件里有没有动 schema (interface / type / enum 声明)
# 有则强制要求 reviewer 双签 (在 .auto-evolve-review-required 文件)
#
# 用法 (在 staging 准备好 patch 后, apply 前):
#   bash scripts/detect-schema-changes.sh <patch-id>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

patch_id="${1:-}"
if [ -z "$patch_id" ]; then
  echo "用法: $0 <patch-id>"
  exit 1
fi

staging_dir="staging/auto-evolve/$patch_id"
if [ ! -d "$staging_dir" ]; then
  echo "❌ staging 不存在: $staging_dir"
  exit 1
fi

flag="$staging_dir/.schema-changed"
rm -f "$flag"

found=0
for patch in "$staging_dir"/*.patch; do
  [ -e "$patch" ] || continue
  # 检查 patch 里有没有新增/修改 interface、type、enum 声明
  if grep -E '^\+.*(interface |type [A-Z][a-zA-Z0-9_]* =|enum [A-Z][a-zA-Z0-9_]*)' "$patch" > /dev/null 2>&1; then
    found=1
    echo "⚠️  schema 改动检测到: $patch"
    grep -E '^\+.*(interface |type [A-Z][a-zA-Z0-9_]* =|enum [A-Z][a-zA-Z0-9_]*)' "$patch" | head -3
  fi
done

if [ $found -eq 1 ]; then
  touch "$flag"
  echo ""
  echo "🚨 schema 改动标记: $flag"
  echo "   护栏 6 触发: apply 时会强制要求双签 reviewer"
else
  echo "✅ 无 schema 改动, 走单签"
fi
