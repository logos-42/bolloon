#!/usr/bin/env bash
# Bolloon iOS 出包全流程: web → dist/ios → cap sync → build/archive
# 用法:
#   bash scripts/build-ios.sh            # 出 .xcarchive (真机 Release, 需签名)
#   bash scripts/build-ios.sh --sim      # 模拟器 Debug 构建 (免签名, 快速验证)
#   bash scripts/build-ios.sh --verify   # 真机 Release 编译 (免签名, 只验证能编译)
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-archive}"

echo "① 构建 web (dist/web)"
npm run build:web >/dev/null
echo "② 组装 dist/ios (mobile.html → index.html)"
node scripts/build-ios-web.mjs
echo "③ Capacitor 同步到 ios/App/App/public"
CAP_WEB_DIR=dist/ios npx cap sync ios >/dev/null
echo "   ✔ sync 完成"

# —— 定位 Xcode (支持非 /Applications 安装, 免 sudo) ——
if ! xcodebuild -version >/dev/null 2>&1; then
  for X in "/Applications/Xcode.app" "$HOME/Downloads/Xcode.app" "$HOME/Applications/Xcode.app"; do
    if [ -d "$X/Contents/Developer" ]; then
      export DEVELOPER_DIR="$X/Contents/Developer"
      echo "   使用 Xcode: $X (DEVELOPER_DIR)"
      break
    fi
  done
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  echo ""
  echo "⚠️  未找到可用的 Xcode。macOS 13 Ventura 最高支持 **Xcode 15.2**:"
  echo "   https://developer.apple.com/download/all/ → Xcode_15.2.xip → xip --expand → /Applications"
  exit 3
fi
xcodebuild -version | head -1

PROJ="ios/App/App.xcodeproj"; SCHEME="App"

case "$MODE" in
  --sim)
    echo "④ 模拟器 Debug 构建 (ad-hoc 签名, 无需 Apple ID/Team)"
    # 注意: 不能用 CODE_SIGNING_ALLOWED=NO — 那样 App 未签名, 模拟器里容器/权限失败, WKWebView 白屏.
    # 模拟器用 ad-hoc 签名 (CODE_SIGN_IDENTITY=-) 即可, 不需要开发者账号.
    xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Debug -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd build \
      CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO | tail -3
    echo "✅ 模拟器 App: build/dd/Build/Products/Debug-iphonesimulator/App.app"
    echo "   运行: xcrun simctl install booted <app> && xcrun simctl launch booted com.bolloon.agent"
    ;;
  --verify)
    echo "④ 真机 Release 编译 (免签名, 仅验证能编译)"
    xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release -sdk iphoneos \
      -derivedDataPath build/dd-dev build CODE_SIGNING_ALLOWED=NO | tail -3
    echo "✅ 真机 App: build/dd-dev/Build/Products/Release-iphoneos/App.app"
    ;;
  *)
    echo "④ Archive (Release, 需签名)"
    mkdir -p build
    if xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
         -archivePath build/App.xcarchive archive 2>&1 | tail -20; then
      echo "✅ 完成: build/App.xcarchive → Xcode Organizer (open build/App.xcarchive) 导出 .ipa"
    else
      cat <<'EOF'

⚠️  Archive 失败 — 通常是**未配置签名** (Signing & Capabilities 里没有 Development Team)。
   在 Xcode 打开 ios/App/App.xcodeproj → 选 App target → Signing & Capabilities:
     - 勾 Automatically manage signing
     - Team 选你的 Apple ID (免费账号可装自己 iPhone, 7 天有效)
   然后再跑 npm run ios:build。
   只验证能否编译(免签名): npm run ios:verify
EOF
      exit 4
    fi
    ;;
esac
