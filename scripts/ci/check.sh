#!/usr/bin/env bash
# L1 代码质量门禁 —— 本地与 CI 同一入口。
#
# 用法:
#   bash scripts/ci/check.sh              # 全量 L1
#   bash scripts/ci/check.sh fmt          # 只跑某一项 (fmt|check|all-features|no-default|clippy)
#   CLIPPY_STRICT=1 bash scripts/ci/check.sh clippy   # 严格：把 clippy 告警当失败
#
# 注意: 仓库存在 45 条**存量** clippy 告警（见 docs/ci/clippy-baseline.md）。
#   默认 CLIPPY_STRICT=0 ⇒ clippy 只统计、不阻断；清完存量后再改默认 1。
#
# 退出码: 0 = 全过; 1 = 有任一项失败。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/rust" || exit 2

ONLY="${1:-all}"
FAIL=0
ONLY_RAN=0

step() { printf '\n── %s ──\n' "$1"; }
ok()   { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=1; }

run() {
  local name="$1"; shift
  ONLY_RAN=1
  step "$name"
  if "$@"; then ok "$name"; else bad "$name"; fi
}

# ---- fmt ----
if [[ "$ONLY" == "all" || "$ONLY" == "fmt" ]]; then
  run "cargo fmt --all -- --check" cargo fmt --all -- --check
fi

# ---- cargo check (默认 feature) ----
if [[ "$ONLY" == "all" || "$ONLY" == "check" ]]; then
  run "cargo check --workspace --all-targets" \
    cargo check --workspace --all-targets
fi

# ---- cargo check (全 feature) ----
if [[ "$ONLY" == "all" || "$ONLY" == "all-features" ]]; then
  run "cargo check --workspace --all-targets --all-features" \
    cargo check --workspace --all-targets --all-features
fi

# ---- cargo check (no-default, 验证 feature 正交性) ----
if [[ "$ONLY" == "all" || "$ONLY" == "no-default" ]]; then
  run "cargo check -p bolloon-web --no-default-features" \
    cargo check -p bolloon-web --no-default-features
fi

# ---- clippy ----
if [[ "$ONLY" == "all" || "$ONLY" == "clippy" ]]; then
  if [[ "${CLIPPY_STRICT:-0}" == "0" ]]; then
    ONLY_RAN=1
    step "cargo clippy（非严格模式，仅统计；存量债见 docs/ci/clippy-baseline.md）"
    cargo clippy --workspace --all-targets --all-features --message-format short > /tmp/bolloon-clippy.log 2>&1 || true
    n=$(grep -cE ': (warning|error):' /tmp/bolloon-clippy.log 2>/dev/null || true)
    echo "clippy 告警行数: ${n:-0}（明细: /tmp/bolloon-clippy.log）"
  else
    run "cargo clippy --workspace --all-targets --all-features -- -D warnings" \
      cargo clippy --workspace --all-targets --all-features -- -D warnings
  fi
fi

if [[ "$ONLY_RAN" == "0" ]]; then
  echo "未知子命令: $ONLY（可选: fmt|check|all-features|no-default|clippy|all）" >&2
  exit 2
fi

printf '\nL1 结果: %s\n' "$([[ $FAIL == 0 ]] && echo PASS || echo FAIL)"
exit $FAIL
