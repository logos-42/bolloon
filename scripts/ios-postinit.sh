#!/usr/bin/env bash
# ios-postinit.sh — 修正 `tauri ios init` 生成的 Xcode 工程缺失项
#
# 背景（2026-11-17 实机踩到）：
#   1) project.yml 没写 ASSETCATALOG_COMPILER_APPICON_NAME ⇒ 桌面图标空白
#   2) iOS ATS 默认拦 http://127.0.0.1 ⇒ 内嵌 axum 页面打不开
#   3) 无 Apple Team 时模拟器构建也需要签名 ⇒ 本地开发直接失败
#
# 用法（在 `cargo tauri ios init` 之后执行一次）：
#   bash scripts/ios-postinit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLE="$ROOT/rust/app-tauri/src-tauri/gen/apple"
SPEC="$APPLE/project.yml"
[[ -f "$SPEC" ]] || { echo "✗ 找不到 $SPEC，先跑 cargo tauri ios init"; exit 1; }

python3 - "$SPEC" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
anchor = '        EXCLUDED_ARCHS[sdk=iphoneos*]: x86_64\n'
add = ''
if 'ASSETCATALOG_COMPILER_APPICON_NAME' not in s:
    add += '        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon\n'
if 'NSAllowsLocalNetworking' not in s:
    s = s.replace('        LSRequiresIPhoneOS: true\n',
                  '        LSRequiresIPhoneOS: true\n        NSAppTransportSecurity:\n          NSAllowsLocalNetworking: true\n')
if 'CODE_SIGNING_ALLOWED' not in s:
    add += '        CODE_SIGNING_ALLOWED: false\n        CODE_SIGNING_REQUIRED: false\n        CODE_SIGN_IDENTITY: ""\n'
if add and anchor in s:
    s = s.replace(anchor, anchor + add)
p.write_text(s)
print('✓ project.yml 已补 AppIcon / ATS / 模拟器免签名')
PY

if command -v xcodegen >/dev/null 2>&1; then
  ( cd "$APPLE" && xcodegen generate --spec project.yml >/dev/null && echo "✓ xcodeproj 已重生成" )
else
  echo "⚠ 未找到 xcodegen：先装（官方 release 解压即可），再在 $APPLE 跑 xcodegen generate"
fi

echo "下一步：bash scripts/build-mobile.sh ios（真机/归档仍需 Apple Team）"
