#!/usr/bin/env bash
# L5 安全与依赖门禁。
#
# 诚实边界:
#   - `cargo-audit` / `cargo-deny` 未安装时明确 SKIP（不会伪报 PASS）。
#   - secret 扫描是**启发式**，只兜底明显泄漏（私钥头 / AWS key / GitHub token）。
#
# 用法:
#   bash scripts/ci/security.sh            # 缺工具 → SKIP 但整体不失败
#   SECURITY_STRICT=1 bash scripts/ci/security.sh   # 缺工具也判失败
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/rust" || exit 2

STRICT="${SECURITY_STRICT:-0}"
FAIL=0
SKIPPED=0

note() { printf '\n── %s ──\n' "$1"; }
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=1; }
skip() { printf 'SKIP: %s\n' "$1"; SKIPPED=1; }

# 1) 依赖漏洞
note "cargo audit"
if cargo audit --version >/dev/null 2>&1; then
  if cargo audit; then pass "cargo audit"; else fail "cargo audit（发现漏洞/或执行失败）"; fi
else
  skip "cargo-audit 未安装（cargo install cargo-audit）"
  [[ "$STRICT" == "1" ]] && fail "SECURITY_STRICT=1 但缺 cargo-audit"
fi

# 2) 许可证 / 依赖策略
note "cargo deny"
if cargo deny --version >/dev/null 2>&1; then
  if [[ -f "$ROOT/rust/deny.toml" ]]; then
    if cargo deny check; then pass "cargo deny check"; else fail "cargo deny check"; fi
  else
    skip "未配置 rust/deny.toml（cargo deny 需要策略文件）"
  fi
else
  skip "cargo-deny 未安装（cargo install cargo-deny）"
  [[ "$STRICT" == "1" ]] && fail "SECURITY_STRICT=1 但缺 cargo-deny"
fi

# 3) Cargo.lock 完整性
note "cargo check --locked"
if cargo check --workspace --locked --quiet; then pass "Cargo.lock 与 workspace 一致"; else fail "Cargo.lock 不一致（先提交 lock 变更）"; fi

# 4) Unsafe 清单（只统计，不阻断）
note "unsafe 位置（供审计，不阻断）"
UNSAFE_N=$(grep -rnE 'unsafe[[:space:]]*\{|unsafe[[:space:]]+fn|unsafe[[:space:]]+impl' crates --include='*.rs' 2>/dev/null | wc -l | tr -d ' ')
echo "命中行数: $UNSAFE_N"
grep -rnE 'unsafe[[:space:]]*\{|unsafe[[:space:]]+fn|unsafe[[:space:]]+impl' crates --include='*.rs' 2>/dev/null | head -40

# 5) Secret 启发式扫描
note "secret 扫描"
# 注意:
#   1) 必须带 `-----` 头，否则会把 shell 工具里的黑名单字符串误判成泄漏。
#   2) 用 find -prune 排除 target/.git/node_modules —— BSD grep 不支持 --exclude-dir。
# 范围只扫 Rust / CI / 脚本；不扫 TS 测试（假凭证样例）与 contracts（含第三方 forge-std）。
SECRET_HITS="$(find rust .github scripts \
  \( -name .git -o -name target -o -name node_modules -o -name dist \) -prune -o \
  -type f -print0 2>/dev/null \
  | xargs -0 grep -InE -- '-----BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}' 2>/dev/null \
  | head -20 || true)"
if [[ -n "$SECRET_HITS" ]]; then
  echo "$SECRET_HITS"
  fail "疑似 secret 泄漏（人工确认后移出）"
else
  pass "未发现明显 secret"
fi

printf '\nL5 结果: %s%s\n' \
  "$([[ $FAIL == 0 ]] && echo PASS || echo FAIL)" \
  "$([[ $SKIPPED == 1 && $FAIL == 0 ]] && echo '（含 SKIP 项）' || true)"
exit $FAIL
