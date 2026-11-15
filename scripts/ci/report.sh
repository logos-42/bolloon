#!/usr/bin/env bash
# 汇总 CI 报告（真实执行，不编造数字）。
#
# 用法:
#   bash scripts/ci/report.sh            # 跑 L1/L2/L3/L5 并打印报告
#   bash scripts/ci/report.sh --fast     # 跳过 L3（PR 快速反馈）
#
# 每层日志独立落盘: /tmp/bolloon-ci-<layer>.log（失败证据不会被下一层覆盖）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

run_layer() {
  local layer="$1"; local label="$2"; shift 2
  local log="/tmp/bolloon-ci-${layer}.log"
  printf '  · %s ... ' "$label" >&2
  if "$@" >"$log" 2>&1; then
    printf 'PASS\n' >&2
    echo "PASS"
  else
    printf 'FAIL\n' >&2
    echo "FAIL"
  fi
}

echo "收集结果中（每层日志: /tmp/bolloon-ci-<layer>.log）..." >&2

L1="$(run_layer l1 L1 bash "$ROOT/scripts/ci/check.sh")"
L2="$(run_layer l2 L2 bash "$ROOT/scripts/ci/test.sh")"
if [[ "$FAST" == "1" ]]; then
  L3="NOT RUN"
else
  L3="$(run_layer l3 L3 bash "$ROOT/scripts/ci/integration.sh")"
fi
L4="NOT RUN"
L5="$(run_layer l5 L5 bash "$ROOT/scripts/ci/security.sh")"

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

FINAL="PASS"
for s in "$L1" "$L2" "$L3" "$L5"; do
  [[ "$s" == "FAIL" ]] && FINAL="FAIL"
done

cat <<EOF

============================
BOLLOON RUST CI REPORT
============================
Commit: $SHA ($BRANCH)

L1 Code Quality : $L1
L2 Unit Tests   : $L2
L3 Integration  : $L3
L4 Reliability  : $L4   (基准/压测见 rust-nightly.yml)
L5 Security     : $L5

Final Status    : $FINAL
============================
说明: 每层真实输出见 /tmp/bolloon-ci-<layer>.log（l1/l2/l3/l5）。
      NOT RUN = 本模式未执行；某层内部的 SKIP（如缺 cargo-audit）见该层日志。
EOF

[[ "$FINAL" == "PASS" ]]
