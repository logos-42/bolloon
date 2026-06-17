#!/bin/sh
# 2026-06-17: lefthook helper — agent auto-evolve branch detection
# 写在独立文件里避免 lefthook 嵌套引号 + Windows bash 解析问题
# 用法: lefthook.yml 里 run: sh scripts/lefthook-helper.sh <command>
#   <command> = commit | vitest-full | build-check | tag-baseline

CMD="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "none")
AUTO_EVOLVE_MSG=$(git log -1 --pretty='%B' 2>/dev/null | head -1 | grep -c '^auto-evolve:' || true)

is_master_main() {
  [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]
}

is_auto_evolve() {
  [ "$BOLLOON_AUTO_EVOLVE" = "1" ] || [ "$AUTO_EVOLVE_MSG" -gt 0 ]
}

case "$CMD" in
  commit-vitest-bail)
    if is_auto_evolve; then
      echo "[skip] vitest-bail (auto-evolve mode, branch=$BRANCH)"
      exit 0
    fi
    npx vitest run --bail=1 --reporter=dot
    ;;
  commit-tsc-check)
    if is_auto_evolve; then
      echo "[skip] tsc-check (auto-evolve mode, branch=$BRANCH)"
      exit 0
    fi
    npx tsc --noEmit
    ;;
  push-vitest-full)
    if is_master_main; then
      npx vitest run --reporter=dot
    else
      echo "[skip] vitest-full (branch=$BRANCH, not master/main)"
      exit 0
    fi
    ;;
  push-build-check)
    if is_master_main; then
      npm run build:main
    else
      echo "[skip] build-check (branch=$BRANCH, not master/main)"
      exit 0
    fi
    ;;
  push-tag-baseline)
    if is_master_main; then
      if git tag -l 'auto-evolve-baseline-*' | grep -q .; then
        exit 0
      else
        echo "[ERROR] push to master/main requires auto-evolve-baseline-* tag. Run: bash scripts/auto-evolve-snapshot.sh"
        exit 1
      fi
    else
      echo "[skip] tag-baseline (branch=$BRANCH, not master/main)"
      exit 0
    fi
    ;;
  *)
    echo "Unknown command: $CMD"
    exit 1
    ;;
esac
