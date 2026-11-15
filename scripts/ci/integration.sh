#!/usr/bin/env bash
# L3 集成测试门禁。
#
# 说明（诚实边界）:
#   本仓多数集成测试依赖本机 `~/.bolloon` 运行态或真实网络/多节点，不适合在 PR 上无脑全跑。
#   因此这里只跑 `crates/*/tests/` 下**独立**的集成测试目标；没有则明确 SKIP。
#
# 用法:
#   bash scripts/ci/integration.sh            # 跑所有 *tests* 目标
#   bash scripts/ci/integration.sh --list     # 只列出有哪些集成测试目标
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/rust" || exit 2

list_targets() {
  find crates -maxdepth 2 -type d -name tests -print 2>/dev/null | while read -r d; do
    find "$d" -maxdepth 1 -type f -name '*.rs' -print 2>/dev/null
  done
}

TARGETS="$(list_targets || true)"

# --list 优先：没有目标时也要能列出（空列表）。
if [[ "${1:-}" == "--list" ]]; then
  echo "$TARGETS"
  exit 0
fi

if [[ -z "$TARGETS" ]]; then
  echo "SKIP: rust/crates 下没有 crates/*/tests/ 集成测试目标"
  exit 0
fi

echo "── 集成测试目标 ──"
echo "$TARGETS"

# --tests 只跑集成/单元测试二进制；--no-fail-fast 让所有目标都尝试执行，便于一次看全。
cargo test --workspace --tests --no-fail-fast
rc=$?
printf '\nL3 结果: %s\n' "$([[ $rc == 0 ]] && echo PASS || echo FAIL)"
exit $rc
