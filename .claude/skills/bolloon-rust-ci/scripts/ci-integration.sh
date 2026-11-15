#!/usr/bin/env bash
# Skill 入口 → 仓内真实 L3 脚本。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec bash "$ROOT/scripts/ci/integration.sh" "$@"
