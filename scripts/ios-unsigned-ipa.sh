#!/usr/bin/env bash
# 未签名 .ipa 打包 (无需 Apple 账号 / 无需设备)
#
#   用途: 给 AltStore / SideStore / iOS App Signer 等"用用户自己的 Apple ID 签名"的自助安装方式用;
#         也可给有 Mac 的用户自己 codesign 后装。未签名 ipa 本身**不能**直接双击安装。
#
#   产物: build/ipa/Bolloon-unsigned.ipa
#   用法: bash scripts/ios-unsigned-ipa.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -z "${DEVELOPER_DIR:-}" ]; then
  for d in /Applications/Xcode.app "$HOME/Downloads/Xcode.app"; do
    [ -d "$d" ] && export DEVELOPER_DIR="$d/Contents/Developer" && break
  done
fi
[ -n "${DEVELOPER_DIR:-}" ] || { echo "❌ 未找到 Xcode"; exit 1; }
export PATH="$DEVELOPER_DIR/usr/bin:$PATH"

echo "① web 产物 → iOS 工程"
npm run build:web
npm run build:ios-web
npm run ios:sync

echo "② 编译 (Release, iphoneos, 不签名)"
rm -rf "$ROOT/build/dd-unsigned"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -derivedDataPath "$ROOT/build/dd-unsigned" build CODE_SIGNING_ALLOWED=NO \
  > /tmp/bolloon-unsigned.log 2>&1 || { tail -25 /tmp/bolloon-unsigned.log; echo "❌ 编译失败"; exit 1; }

APP="$ROOT/build/dd-unsigned/Build/Products/Release-iphoneos/App.app"
[ -d "$APP" ] || { tail -20 /tmp/bolloon-unsigned.log; echo "❌ 未找到 App.app"; exit 1; }

echo "③ 封装 .ipa (Payload/App.app → zip)"
rm -rf "$ROOT/build/ipa-unsigned" "$ROOT/build/ipa"
mkdir -p "$ROOT/build/ipa-unsigned/Payload"
cp -R "$APP" "$ROOT/build/ipa-unsigned/Payload/"
( cd "$ROOT/build/ipa-unsigned" && zip -qry "$ROOT/build/ipa/Bolloon-unsigned.ipa" Payload 2>/dev/null \
  || { mkdir -p "$ROOT/build/ipa" && zip -qry "$ROOT/build/ipa/Bolloon-unsigned.ipa" Payload; } )

IPA="$ROOT/build/ipa/Bolloon-unsigned.ipa"
echo "✅ 完成: $IPA ($(du -h "$IPA" | cut -f1))"
echo "   bundle: $(plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist")  版本: $(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")"
echo "   安装方式: AltStore / SideStore / iOS App Signer 用你自己的 Apple ID 签名后安装"
