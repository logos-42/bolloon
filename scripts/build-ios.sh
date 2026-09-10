#!/usr/bin/env bash
# Bolloon iOS 出包全流程: web → dist/ios → cap sync → archive
# 真机/上架需完整 Xcode + Apple Developer 签名; 模拟器无需签名.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "① 构建 web (dist/web)"
npm run build:web

echo "② 组装 dist/ios (mobile.html → index.html)"
node scripts/build-ios-web.mjs

echo "③ Capacitor 同步到 ios/App/App/public (入口=mobile.html)"
CAP_WEB_DIR=dist/ios npx cap sync ios

if ! xcodebuild -version >/dev/null 2>&1; then
  echo ""
  echo "⚠️  未检测到完整 Xcode (xcodebuild 不可用)。iOS 编译/打包必须安装 Xcode:"
  echo "   1. App Store 安装 Xcode (需你的 Apple ID)"
  echo "   2. sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  echo "   3. 真机运行:  npx cap open ios   (Xcode 里选 Signing Team)"
  echo "   4. 命令行 archive:"
  echo "      xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \\"
  echo "        -archivePath build/App.xcarchive archive"
  echo "   5. Xcode Organizer → Distribute App → 导出 .ipa"
  echo ""
  echo "   模拟器(无签名): xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator build"
  exit 3
fi

echo "④ Archive (Release)"
mkdir -p build
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -archivePath build/App.xcarchive archive

echo "✅ 完成: build/App.xcarchive → Xcode Organizer 导出 .ipa"
