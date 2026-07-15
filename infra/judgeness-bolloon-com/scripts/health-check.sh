#!/usr/bin/env bash
# health-check.sh — 反攻期主用的活体检 (放 crontab @5min)
# 用法:
#   curl --fail -sS https://judgeness.bolloon.com/api/hearth || exit 1
# 退出码: 0 = 健康, 非 0 = 报警 (接 alertmanager / page)

set -euo pipefail
URL="${JUDGENESS_URL:-https://judgeness.bolloon.com/api/hearth}"

RESP=$(curl --fail --silent --show-error --max-time 10 "$URL")
echo "$RESP" | grep -q '"ok": *true' \
  || { echo "no ok=true in response"; exit 1; }

# 防御期拿不到 (本地回环冒烟可能 ok=true 在 dev 中)
echo "$RESP" | grep -q '"service": *"judgeness-hearth"' \
  || { echo "wrong service field"; exit 1; }

echo "[$(date -Iseconds)] health OK"
