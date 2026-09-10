#!/usr/bin/env bash
# Bolloon iOS 出包全流程: web → dist/ios → cap sync → archive
# 需要 Xcode (macOS 13 Ventura 最高支持 Xcode 15.2); 真机安装需签名, 模拟器免签名.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "① 构建 web (dist/web)"
npm run build:web

echo "② 组装 dist/ios (mobile.html → index.html)"
node scripts/build-ios-web.mjs

echo "③ Capacitor 同步到 ios/App/App/public (入口=mobile.html)"
CAP_WEB_DIR=dist/ios npx cap sync ios

# —— 定位 Xcode ——
# 优先当前 toolchain; 若只指向 CommandLineTools 但 /Applications/Xcode.app 在, 自动用它 (免 sudo)
if ! xcodebuild -version >/dev/null 2>&1 && [ -d "/Applications/Xcode.app/Contents/Developer" ]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
  echo "   (自动使用 /Applications/Xcode.app — DEVELOPER_DIR, 无需 sudo)"
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  cat <<'EOF'

⚠️  未检测到完整 Xcode。iOS 编译/打包必须安装 Xcode。

你的系统: macOS 13.7.8 (Ventura) → App Store 的最新 Xcode 要求 macOS 15+，装不上。
可用的最高版本是 **Xcode 15.2** (要求 macOS 13.5+):

  1. 登录 https://developer.apple.com/download/all/  (免费 Apple ID 即可)
  2. 搜索 "Xcode 15.2" → 下载 Xcode_15.2.xip (~2.7GB)
  3. 解压安装:
       xip --expand ~/Downloads/Xcode_15.2.xip
       mv Xcode.app /Applications/          # 若在只读位置则放 ~/Applications
       # 首次启动 Xcode.app 会提示安装附加组件, 按提示完成
  4. 指向该 Xcode (二选一):
       sudo xcode-select -s /Applications/Xcode.app/Contents/Developer     # 有管理员
       export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer     # 免 sudo (推荐)
  5. 重跑:  npm run ios:build
     → build/App.xcarchive, 再用 Xcode Organizer 导出 .ipa

  模拟器构建(免签名, 免 Apple Developer): 
       xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator build
  真机安装: Xcode 打开 ios/App/App.xcodeproj → Signing & Capabilities 选你的 Apple ID Team
           (免费 Apple ID 可装到自己的 iPhone, 7 天有效; 付费开发者账号 1 年)

  说明: App Store 上架需 iOS 18 SDK (Xcode 16+, 要求 macOS 14.5+); 
        Ventura 最高 Xcode 15.2 → 可本地构建/真机安装, 但上架需先升级 macOS.
EOF
  exit 3
fi

echo "④ Archive (Release)"
mkdir -p build
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -archivePath build/App.xcarchive archive

echo "✅ 完成: build/App.xcarchive → Xcode Organizer 导出 .ipa"
