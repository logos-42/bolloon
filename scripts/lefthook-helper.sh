#!/bin/sh
# 2026-06-17: lefthook helper — agent auto-evolve branch detection
# 写在独立文件里避免 lefthook 嵌套引号 + Windows bash 解析问题
# 用法: lefthook.yml 里 run: sh scripts/lefthook-helper.sh <command>
#   <command> = commit | vitest-full | build-check | tag-baseline

CMD="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)
AUTO_EVOLVE_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | grep -c ^auto-evolve: || echo 0)

is_master_main() {
  [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]
}

is_auto_evolve() {
  if [ "$BOLLOON_AUTO_EVOLVE" = "1" ]; then return 0; fi
  if [ "$AUTO_EVOLVE_MSG" -gt 0 ] 2>/dev/null; then return 0; fi
  return 1
}

case "$CMD" in
  commit-vitest-bail)
    # 2026-10-01 (用户: 「为什么这么慢」): 原来这里**每次提交都跑全量** ✗
    #   (291 文件 / ~4570 用例 / 实测 117~265 秒/次 —— 本轮光等钩子就约 25 分钟 ✗),
    #   而 AGENTS.md §5.2.1 白纸黑字写的是「改一处只跑聚焦测试; 全量只在收尾跑一次」✓
    #   ⇒ 规矩与钩子互相矛盾 ✓。现在按**规矩**来: 只跑与**本次暂存文件相关**的测试 ✓。
    #   相关 = ① 同名测试(改 foo.ts ⇒ 跑 foo.test.ts) ② 任何**提到过**这个文件名的测试 ✓
    #   (跨文件的契约门就是这么被捎上的 ✓)。
    #   要全量: LEFTHOOK_FULL=1 git commit …  ✓(收尾/发版时用 ✓)
    if is_auto_evolve; then
      echo "[skip] vitest-bail (auto-evolve mode, branch=$BRANCH)"
      exit 0
    fi
    if [ "$LEFTHOOK_FULL" = "1" ]; then
      echo "[full] LEFTHOOK_FULL=1 ⇒ 跑全量套件"
      npx vitest run --bail=1 --reporter=dot
      exit $?
    fi
    STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^src/.*\.(ts|tsx)$' || true)
    if [ -z "$STAGED" ]; then
      echo "[skip] vitest-bail (暂存区没有 src/*.ts 改动)"
      exit 0
    fi
    PATTERNS=""
    for f in $STAGED; do
      base=$(basename "$f")
      stem=$(echo "$base" | sed 's/\.[a-z]*$//')
      PATTERNS="$PATTERNS|$stem"
    done
    PATTERNS=$(echo "$PATTERNS" | sed 's/^|//')
    SELECTED=$(find src/test -name '*.test.ts' -o -name '*.test.tsx' 2>/dev/null | sort | \
      xargs grep -lE "$PATTERNS" 2>/dev/null || true)
    # 2026-10-02 修 bug: `grep -c .` 在无匹配时既输出 "0" 又 exit 1 ⇒ `|| echo 0` 再补一行
    # ⇒ COUNT="0\n0" ⇒ `[ "$COUNT" = "0" ]` 为假、`[ "$COUNT" -gt 120 ]` 报 "integer expression expected",
    # 结果是**带着空的文件列表**去跑 vitest (看起来像"跑了", 其实聚焦失效)。改成显式初始化。
    COUNT=0
    if [ -n "$SELECTED" ]; then COUNT=$(printf '%s\n' "$SELECTED" | grep -c .); fi
    if [ "$COUNT" = "0" ]; then
      echo "[skip] vitest-bail (没有测试提到本次改动的文件)"
      exit 0
    fi
    if [ "$COUNT" -gt 120 ]; then
      echo "[wide] $COUNT 个测试相关 ⇒ 跑全量(等价)"
      npx vitest run --bail=1 --reporter=dot
      exit $?
    fi
    echo "[focused] $COUNT 个相关测试(共 291 个文件) ⇒ 只跑这些"
    echo "$SELECTED" | tr '\n' ' ' | cut -c1-400
    echo
    npx vitest run --bail=1 --reporter=dot $SELECTED
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
