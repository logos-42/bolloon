#!/usr/bin/env bash
# bolloon-version: 0.4.29
# Bolloon Agent 安装脚本 —— **npm 唯一发行渠道** + **运行时安装协议**
#
# 新的完成定义 (2026-09-19 冻结, leo 计划 Phase 0):
#   **Bolloon 安装完成 = Node/npm、Git、Python 三个运行时都已可执行、版本可验证、路径已配置。**
#   任何一个必需运行时不可用 → 整个安装**不能**宣布成功 (退出码非 0)。
#
# 顺序 (Phase 0-5):
#   环境预检 → 显示计划 → (需要时) 装引导依赖 Node/npm → 装 Bolloon →
#   **Runtime Bootstrap Manager 补齐 Git/Python + PATH + 写入配置** → 硬验证 → 安装报告
#
# 为什么 Git/Python 不在这里用 shell 装:
#   同一份检测/安装/PATH/验证逻辑只允许有一处实现 (否则 install.sh / postinstall /
#   Onboard / doctor 又各有一套)。Bolloon 装好后, Git/Python 统一交给
#   `bolloon runtime install yes` (src/utils/runtime-bootstrap.ts)。
#   例外只有 **Node**: 它是引导依赖 —— 装 Bolloon 之前只能用 shell 装它, 这里如实说明。
#
# 用法:
#   curl -fsSL https://bolloon.cn/install.sh | sh                 # 交互式 (改系统前先问)
#   curl -fsSL https://bolloon.cn/install.sh | sh -s -- --yes     # 免确认 (脚本/CI)
#   curl -fsSL https://bolloon.cn/install.sh | sh -s -- --dry-run # 只看计划, 不做任何修改
#   curl -fsSL https://bolloon.cn/install.sh | sh -s -- --runtime-report  # 只输出运行时报告
#
# 环境变量:
#   BOLLOON_VERSION        指定版本 (如 0.4.29), 默认取 registry 的 latest
#   BOLLOON_PREFIX         覆盖 npm 全局前缀 (默认自动探测; 不可写时用 ~/.npm-global)
#   BOLLOON_NPM_REGISTRY   覆盖 registry (镜像/内网)
#   BOLLOON_ALLOW_SUDO=1   允许用 sudo 装系统包 (默认**不允许** —— 不偷偷提权)
#   BOLLOON_NO_BOOTSTRAP=1 跳过运行时补齐 (只装 Bolloon 本身)
#   BOLLOON_TARBALL=<path.tgz> 从本地 tarball 安装 (不做 registry 解析) —— 发布校验用

set -euo pipefail

PKG="@bolloon/bolloon-agent"
REGISTRY="${BOLLOON_NPM_REGISTRY:-https://registry.npmjs.org}"
VERSION="${BOLLOON_VERSION:-}"
ASSUME_YES=0
DRY_RUN=0
RUNTIME_REPORT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)          ASSUME_YES=1 ;;
    --dry-run)         DRY_RUN=1 ;;
    --runtime-report)  RUNTIME_REPORT_ONLY=1 ;;
    --help|-h)         sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg (试 --help)"; exit 64 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

# ─────────────────────────────────────────────────────────────────────────────
# Phase 0/2: 环境预检 (只读, 不改任何东西)
# ─────────────────────────────────────────────────────────────────────────────

ver_of() {  # ver_of <cmd> [args...] → 版本号或空
  command -v "$1" >/dev/null 2>&1 || return 0
  "$@" 2>/dev/null | head -1 | grep -Eo '[0-9]+(\.[0-9]+)+' | head -1 || true
}
have() { command -v "$1" >/dev/null 2>&1; }

NODE_V="$(ver_of node --version || true)"
NPM_V="$(ver_of npm --version || true)"
GIT_V="$(ver_of git --version || true)"
PY_V=""
for cand in python3 python; do
  if have "$cand"; then PY_V="$(ver_of "$cand" --version)"; break; fi
done

OS="$(uname -s)"
MANAGER="(无)"
case "$OS" in
  Darwin) have brew && MANAGER="brew" ;;
  Linux)  for pm in apt-get dnf yum pacman zypper apk; do have "$pm" && { MANAGER="$pm"; break; }; done ;;
  *)      MANAGER="(未在支持矩阵: $OS)" ;;
esac

say "🔎 环境预检"
say "  平台:      $OS $(uname -m)"
say "  包管理器:  $MANAGER"
say "  Node.js:   ${NODE_V:-缺失}   (最低 18)"
say "  npm:       ${NPM_V:-缺失}    (最低 9)"
say "  Git:       ${GIT_V:-缺失}    (最低 2.20)"
say "  Python:    ${PY_V:-缺失}     (最低 3.8)"

NEED_BOOTSTRAP=""
[ -z "$GIT_V" ] && NEED_BOOTSTRAP="$NEED_BOOTSTRAP git"
[ -z "$PY_V" ]  && NEED_BOOTSTRAP="$NEED_BOOTSTRAP python"
say ""
if [ -z "$NEED_BOOTSTRAP" ]; then
  say "  ✅ 运行时都已就绪 (会复用, 不覆盖你已有的版本)"
else
  warn "  需要补齐:${NEED_BOOTSTRAP}"
  say "  将使用: $MANAGER"
  say "  需要管理员权限: $( [ "$OS" = "Linux" ] && echo "视包管理器 (会明确告知, 不偷偷 sudo)" || echo "否 (brew/user 级)" )"
  say "  将修改 PATH/配置: 是 (写入 ~/.bolloon/config.json 的 runtime.*)"
fi

if [ "$RUNTIME_REPORT_ONLY" = "1" ]; then
  if have bolloon; then exec bolloon runtime verbose; fi
  say ""
  warn "  (Bolloon 还没装, 上面是 shell 侧预检; 装好后用 \`bolloon runtime\` 看权威报告)"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  say ""
  say "🧪 --dry-run: 只显示计划, 不做任何修改 (不装 Node/Git/Python, 不装 Bolloon, 不改 PATH)"
  say "  计划: 1) (如缺 Node) 用 $MANAGER 装 Node.js  2) npm install -g $PKG@${VERSION:-latest}"
  say "        3) bolloon runtime install yes (补 Git/Python + 写 PATH/配置)  4) bolloon --version json + bolloon doctor offline"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 (唯一例外): Node 是引导依赖 —— 装 Bolloon 之前只能用 shell 装它
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "$NODE_V" ]; then
  warn "Node.js 缺失。它必须在装 Bolloon 之前就存在 (引导依赖), 只能用系统包管理器装。"
  if [ "$OS" = "Darwin" ] && ! have brew; then
    err "❌ macOS 上没有 Homebrew。脚本不会静默安装 Homebrew (会写 /opt/homebrew 或 /usr/local, 可能要管理员密码)。"
    err "   请二选一后重跑:"
    err "     · 安装 Homebrew: https://brew.sh  然后 brew install node git python"
    err "     · 或官方安装器: https://nodejs.org (并自行安装 git / python3)"
    exit 1
  fi
  case "$MANAGER" in
    brew)    CMD=(brew install node) ;;
    apt-get) CMD=(sudo apt-get install -y nodejs npm) ;;
    dnf|yum) CMD=(sudo "$MANAGER" install -y nodejs npm) ;;
    pacman)  CMD=(sudo pacman -S --noconfirm nodejs npm) ;;
    zypper)  CMD=(sudo zypper --non-interactive install nodejs npm) ;;
    apk)     CMD=(sudo apk add nodejs npm) ;;
    *)       err "❌ 没有可用的包管理器装 Node.js —— 请手动安装后重跑"; exit 1 ;;
  esac
  say "  将执行: ${CMD[*]}"
  if [ "${BOLLOON_ALLOW_SUDO:-0}" != "1" ] && [ "${CMD[0]}" = "sudo" ]; then
    err "❌ 该命令需要管理员权限。脚本**不会偷偷 sudo**。"
    err "   确认后重跑: BOLLOON_ALLOW_SUDO=1 sh install.sh"
    exit 1
  fi
  if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
    printf '继续安装 Node.js? [Y/n] '
    read -r ans || ans=""
    case "$ans" in n|N|no|NO) say "已取消 (什么都没改)"; exit 0 ;; esac
  fi
  "${CMD[@]}" || { err "❌ Node.js 安装失败 —— 不继续 (安装不能算成功)"; exit 1; }
  hash -r 2>/dev/null || true
  NODE_V="$(ver_of node --version || true)"
  [ -z "$NODE_V" ] && { err "❌ 装完仍找不到 node —— 可能需要重开 shell (PATH 未刷新)"; exit 1; }
fi

NODE_MAJOR="${NODE_V%%.*}"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
  err "❌ Node.js $NODE_V 低于最低要求 18 —— 请升级后再装"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 装 Bolloon (npm = 唯一发行渠道; 不再查 GitHub Releases)
# ─────────────────────────────────────────────────────────────────────────────

if [ -n "${BOLLOON_TARBALL:-}" ]; then
  [ -f "$BOLLOON_TARBALL" ] || { err "❌ BOLLOON_TARBALL 指向的文件不存在: $BOLLOON_TARBALL"; exit 1; }
  VERSION="$(tar -xzOf "$BOLLOON_TARBALL" package/package.json 2>/dev/null | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch(e){}});
' 2>/dev/null || true)"
  [ -n "$VERSION" ] || { err "❌ 无法从 tarball 读出 package.json 版本"; exit 1; }
  SPRUCE="(本地 tarball)"
elif [ -z "$VERSION" ]; then
  VERSION="$(BOLLOON_NPM_REGISTRY="$REGISTRY" node -e '
const https = require("https");
const url = process.env.BOLLOON_NPM_REGISTRY.replace(/\/$/, "") + "/@bolloon%2Fbolloon-agent";
https.get(url, { headers: { Accept: "application/json" } }, (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    try {
      const j = JSON.parse(d);
      const v = (j["dist-tags"] || {}).latest;
      if (v) process.stdout.write(v); else process.exit(3);
    } catch (e) { process.exit(4); }
  });
}).on("error", () => process.exit(2));
' 2>/dev/null)" || true
fi

if [ -z "$VERSION" ]; then
  err "❌ 无法从 npm registry 解析版本 (registry=$REGISTRY)"
  err "   这不代表包不存在 —— 请检查网络/代理, 或用 BOLLOON_VERSION 显式指定版本"
  exit 1
fi
say ""
say "📦 安装 ${PKG}@${VERSION} ${SPRUCE:-}"

PREFIX="${BOLLOON_PREFIX:-$(npm prefix -g 2>/dev/null || echo '')}"
if [ -z "$PREFIX" ] || [ ! -w "$PREFIX/lib" ]; then
  PREFIX="$HOME/.npm-global"
  warn "  默认全局目录不可写 → 改用 ${PREFIX} (不会用 sudo 改系统目录)"
  mkdir -p "$PREFIX"
fi
export npm_config_prefix="$PREFIX"

say "   安装: npm install -g ${PKG}@${VERSION} (prefix=$PREFIX)"
# npm 默认只重试 2 次/10s —— 真网络抖动 (ECONNRESET) 会让一次干净安装直接失败。
# 安装是低频动作, 宁可多等一会也不要假装成功/让用户手动重来。
NPM_RETRY=(--fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000)
if [ -n "${BOLLOON_TARBALL:-}" ]; then SPEC="$BOLLOON_TARBALL"; else SPEC="${PKG}@${VERSION}"; fi
if ! npm install -g "$SPEC" --no-fund --no-audit --loglevel=error "${NPM_RETRY[@]}"; then
  err "❌ npm 安装失败 —— 旧版本(如果有)未被删除, 可继续使用"
  exit 1
fi

BIN_DIR="$PREFIX/bin"
BOLLOON_BIN="${BIN_DIR}/bolloon"
[ -x "$BOLLOON_BIN" ] || { err "❌ 已安装但找不到入口 $BOLLOON_BIN —— 请把 $BIN_DIR 加进 PATH 后重跑"; exit 1; }
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *) warn "  ⚠ $BIN_DIR 不在 PATH —— 请加: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# Phase 1/4/5: 运行时补齐 (唯一实现) + 安装后硬验证
# ─────────────────────────────────────────────────────────────────────────────

BOOTSTRAP_OK=1
if [ "${BOLLOON_NO_BOOTSTRAP:-0}" = "1" ]; then
  warn "  BOLLOON_NO_BOOTSTRAP=1 → 跳过运行时补齐 (只装 Bolloon 本身)"
else
  say ""
  say "🛠  运行时补齐 (Git/Python + PATH + 配置) —— 交给 Bolloon 自己的管理器"
  if ! "$BOLLOON_BIN" runtime install yes; then
    BOOTSTRAP_OK=0
  fi
fi

say ""
say "🔬 安装后硬验证"
VERIFY_FAIL=0

JSON="$("$BOLLOON_BIN" --version json 2>/dev/null || true)"
ACTUAL="$(printf '%s' "$JSON" | node -e '
let s = ""; process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  const i = s.indexOf("{");
  if (i < 0) process.exit(0);
  try { process.stdout.write(JSON.parse(s.slice(i)).packageVersion || ""); } catch (e) {}
});
' 2>/dev/null || true)"

if [ "$ACTUAL" != "$VERSION" ]; then
  err "❌ 版本自检失败: bolloon 报 '${ACTUAL:-读取失败}', 目标是 $VERSION"
  VERIFY_FAIL=1
fi

if ! "$BOLLOON_BIN" doctor offline >/dev/null 2>&1; then
  warn "  ⚠ bolloon doctor 报了问题 (下面单独展示):"
  "$BOLLOON_BIN" doctor offline || true
  VERIFY_FAIL=1
fi

say ""
if [ "$VERIFY_FAIL" = "0" ] && [ "$BOOTSTRAP_OK" = "1" ]; then
  "$BOLLOON_BIN" runtime verbose || true
  say ""
  ok "✅ Bolloon 安装完成: ${PKG}@${ACTUAL}"
  say "   入口: ${BOLLOON_BIN}"
  say "💡 bolloon --version · bolloon doctor · bolloon update (直接更新)"
  exit 0
fi

err "❌ Bolloon 安装未完成"
[ "$BOOTSTRAP_OK" = "1" ] || err "   失败阶段: 运行时补齐 (Git/Python)"
[ "$VERIFY_FAIL" = "0" ] || err "   失败阶段: 安装后硬验证"
err "   处理建议:"
err "     · bolloon runtime               (四个运行时 + 能力矩阵, 写明缺什么)"
err "     · bolloon runtime install yes   (补装; 不偷偷 sudo)"
err "     · bolloon doctor                (安装入口/版本/更新/运行时逐项结论)"
exit 1
