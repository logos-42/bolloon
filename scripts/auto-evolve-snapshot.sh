#!/bin/bash
# auto-evolve-snapshot.sh — 阶段 C 护栏 2 + 3
#
# 用法 (LLM 改源码前必调):
#   bash scripts/auto-evolve-snapshot.sh          # 打 baseline tag + 记当前 HEAD
#   bash scripts/auto-evolve-snapshot.sh apply <patch-id>   # 人类批准后合并 staging → main
#   bash scripts/auto-evolve-snapshot.sh list      # 列所有 baseline
#   bash scripts/auto-evolve-snapshot.sh rollback <tag>     # 回滚到指定 baseline
#
# 流程:
#   1. LLM 改之前调 snapshot: 当前 HEAD 打 auto-evolve-baseline-<ts> tag
#   2. LLM 改 staging/auto-evolve/<patch-id>/  (不进 src/)
#   3. 护栏 1 (lefthook) 跑 vitest + tsc, 坏就 abort
#   4. 护栏 4 (reviewer hook) 审 diff, 通过才准 apply
#   5. 人类调 apply: git apply staging/auto-evolve/<patch-id>/*.patch → src/
#   6. 出问题: 调 rollback → git reset --hard <tag>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

STAGING_DIR="staging/auto-evolve"
TAG_PREFIX="auto-evolve-baseline-"

cmd="${1:-snapshot}"
patch_id="${2:-}"

case "$cmd" in
  snapshot)
    # 护栏 2: 打 baseline tag
    if ! git diff --quiet HEAD 2>/dev/null; then
      echo "❌ 有未提交改动. 先 git commit 或 git stash"
      exit 1
    fi
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    tag="${TAG_PREFIX}${ts}"
    git tag -a "$tag" -m "auto-evolve baseline @ ${ts}" HEAD
    echo "✅ baseline tag: $tag"
    echo "$tag" > .last-auto-evolve-baseline
    echo "   回滚命令: bash $0 rollback $tag"
    ;;

  prepare)
    # LLM 改之前调: 创建 staging 目录
    if [ -z "$patch_id" ]; then
      echo "用法: $0 prepare <patch-id>"
      exit 1
    fi
    mkdir -p "$STAGING_DIR/$patch_id"
    echo "$patch_id" > "$STAGING_DIR/$patch_id/.patch-id"
    echo "✅ staging 创建: $STAGING_DIR/$patch_id/"
    echo "   LLM 改完后把 patch 放这里: $STAGING_DIR/$patch_id/*.patch"
    ;;

  apply)
    # 人类批准: 把 staging 的 patch 合并到 src/
    if [ -z "$patch_id" ]; then
      echo "用法: $0 apply <patch-id>"
      exit 1
    fi
    patch_dir="$STAGING_DIR/$patch_id"
    if [ ! -d "$patch_dir" ]; then
      echo "❌ staging 不存在: $patch_dir"
      exit 1
    fi
    # 必须先 snapshot
    if [ ! -f .last-auto-evolve-baseline ]; then
      echo "❌ 没有 baseline. 先跑: $0 snapshot"
      exit 1
    fi
    baseline="$(cat .last-auto-evolve-baseline)"

    # 应用所有 patch
    applied=0
    for p in "$patch_dir"/*.patch; do
      [ -e "$p" ] || continue
      echo "  applying: $p"
      if ! git apply --check "$p"; then
        echo "❌ patch 不可用: $p (可能已应用过)"
        exit 1
      fi
      git apply "$p"
      applied=$((applied + 1))
    done

    if [ $applied -eq 0 ]; then
      echo "❌ staging 里没有 .patch 文件"
      exit 1
    fi

    echo "✅ 应用 $applied 个 patch"
    echo "   建议现在跑: npm test  +  git commit -m 'auto-evolve: $patch_id'"
    echo "   出问题回滚: $0 rollback $baseline"
    ;;

  rollback)
    # 回滚到指定 baseline
    if [ -z "$patch_id" ]; then
      echo "用法: $0 rollback <tag>"
      echo "可用的 baseline:"
      git tag -l "${TAG_PREFIX}*" | sort -r | head -10
      exit 1
    fi
    if ! git tag -l | grep -qx "$patch_id"; then
      echo "❌ tag 不存在: $patch_id"
      exit 1
    fi
    echo "⚠️  将回滚到 $patch_id (hard reset, 丢弃之后所有改动)"
    read -p "确认? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      git reset --hard "$patch_id"
      echo "✅ 回滚到 $patch_id"
    else
      echo "取消"
    fi
    ;;

  list)
    echo "auto-evolve baselines (最近 10):"
    git tag -l "${TAG_PREFIX}*" | sort -r | head -10 | while read tag; do
      msg="$(git tag -l --format='%(contents)' "$tag" | head -1)"
      echo "  $tag — $msg"
    done
    if [ -f .last-auto-evolve-baseline ]; then
      echo ""
      echo "当前 baseline: $(cat .last-auto-evolve-baseline)"
    fi
    ;;

  *)
    echo "用法: $0 {snapshot|prepare <id>|apply <id>|rollback <tag>|list}"
    exit 1
    ;;
esac
