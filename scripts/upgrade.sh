#!/usr/bin/env bash
# bolloon-version: 0.4.29
# 升级 Bolloon Agent —— 只是 `bolloon update` 的一层薄包装 (单一更新实现)。
#
# 为什么不再直接 `npm install -g latest`:
#   那样会绕过**更新计划 / 更新锁 / 目标版本校验 / 切换后验证 / 失败回滚** ——
#   同一次升级, 走 CLI 有保护, 走这个脚本没有, 等于两套更新语义。
#
# 用法:
#   bash scripts/upgrade.sh              # 直接更新 (等价 bolloon update: 先打印计划, 再执行)
#   bash scripts/upgrade.sh plan         # 只看计划
#   bash scripts/upgrade.sh force        # 忽略"有长期任务在跑"的提醒, 仍然更新
set -euo pipefail

PKG="@bolloon/bolloon-agent"

if command -v bolloon >/dev/null 2>&1; then
  BOLLOON="bolloon"
  echo "🔄 通过 bolloon update 升级 (计划 → 执行 → 健康检查)..."
  # `plan` / `--plan` 仍被接受 —— 就是新的只读位 `--dry-run` (只打印, 不装任何东西)
  if [ "${1:-}" = "plan" ] || [ "${1:-}" = "--plan" ] || [ "${1:-}" = "--dry-run" ]; then
    exec "$BOLLOON" update --dry-run
  fi
  exec "$BOLLOON" update "$@"
fi

# 兜底: 没有任何 bolloon 入口时 (源码目录直跑) 退回 npm, 并说明为什么少了保护
echo "⚠  未找到 bolloon 入口 (不在 PATH), 退回直接 npm 安装 —— 本次没有更新计划/回滚保护"
if npm install -g "${PKG}@latest" --no-fund --no-audit --fetch-retries=5 --fetch-retry-maxtimeout=120000; then
  echo "✅ 升级完成。"
  echo "💡 请重新运行 bolloon 以使用新版本; 体检: bolloon doctor"
else
  echo "❌ 升级失败。若提示权限不足, 不要用 sudo 改系统目录, 改用用户前缀:"
  echo "   npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  exit 1
fi
