#!/usr/bin/env bash
# Skill 入口 → 仓内真实报告脚本。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec bash "$ROOT/scripts/ci/report.sh" "$@"
