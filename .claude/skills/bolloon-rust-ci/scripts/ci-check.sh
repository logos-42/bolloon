#!/usr/bin/env bash
# Skill 入口 → 仓内真实 L1 脚本（单一真源，不复制逻辑）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec bash "$ROOT/scripts/ci/check.sh" "$@"
