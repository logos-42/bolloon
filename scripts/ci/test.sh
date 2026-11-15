#!/usr/bin/env bash
# L2 单元测试门禁。
#
# 用法:
#   bash scripts/ci/test.sh                 # workspace 全部 lib 单测
#   bash scripts/ci/test.sh bolloon-agent   # 只跑某个 crate
#   bash scripts/ci/test.sh bolloon-web directory   # crate + 测试名过滤
#
# 说明: 只跑 `--lib`（与既有 rust.yml 一致）。集成测试见 integration.sh。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/rust" || exit 2

CRATE="${1:-}"
FILTER="${2:-}"

args=(test --lib)
[[ -n "$CRATE" ]] && args+=(-p "$CRATE")
if [[ -n "$FILTER" ]]; then
  args+=(-- "$FILTER")
fi

echo "── cargo ${args[*]} ──"
cargo "${args[@]}"
rc=$?
printf '\nL2 结果: %s\n' "$([[ $rc == 0 ]] && echo PASS || echo FAIL)"
exit $rc
