#!/usr/bin/env bash
# Bolloon iOS 出包 + 发布 (GitHub Release 资产 → bolloon-UI 安装页 OTA)
#
#   用法:  bash scripts/ios-release.sh [版本号]      # 默认取 package.json 的 version
#   环境:  TEAM_ID=4H9BX87VAC (可覆盖)
#          BOLLOON_UI_DIR=~/Downloads/bolloon-UI
#          SKIP_BUILD=1  仅归档导出 (跳过 web 构建)
#          SKIP_PUBLISH=1 只出包不上传/不改站点
#          METHOD=adhoc  付费账号时给他人装 (朋友需先提供 UDID 登记)
#
#   前置: 免费 Personal Team 无法在"没有已登记设备"时生成描述文件 →
#         先把 iPhone 用 USB 连上 Mac 并在设备上点「信任」, 再跑本脚本
#         (带 -allowProvisioningDeviceRegistration, 会自动登记该设备)
#
#   产出: build/ipa/*.ipa  →  bolloon-UI Release 资产
#         bolloon-UI/ios/manifest.plist + install.html 的 iOS 入口
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TEAM_ID="${TEAM_ID:-4H9BX87VAC}"
SCHEME="App"
APP_NAME="Bolloon"
UI_DIR="${BOLLOON_UI_DIR:-$HOME/Downloads/bolloon-UI}"
UI_REPO="logos-42/bolloon-UI"
PAGES_URL="https://logos-42.github.io/bolloon-UI"
VER="${1:-$(node -p "require('./package.json').version")}"
TAG="ios-v${VER}"

# ---- Xcode (本机可能不在 /Applications) ----
if [ -z "${DEVELOPER_DIR:-}" ]; then
  for d in /Applications/Xcode.app "$HOME/Downloads/Xcode.app"; do
    if [ -d "$d" ]; then export DEVELOPER_DIR="$d/Contents/Developer"; break; fi
  done
fi
[ -n "${DEVELOPER_DIR:-}" ] || { echo "❌ 未找到 Xcode (可 export DEVELOPER_DIR=…/Xcode.app/Contents/Developer)"; exit 1; }
export PATH="$DEVELOPER_DIR/usr/bin:$PATH"
echo "Xcode: $DEVELOPER_DIR"
echo "版本: $VER    Team: $TEAM_ID"

# ---- ① web 产物 → iOS 工程 ----
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "① 构建 web 产物并同步进 iOS 工程…"
  npm run build:web
  npm run build:ios-web
  npm run ios:sync
fi

# ---- ② 归档 (自动签名 + 自动登记已连接设备) ----
echo "② 归档 (Release, iphoneos)…"
rm -rf "$ROOT/build/App.xcarchive" "$ROOT/build/ipa"
if ! xcodebuild -project ios/App/App.xcodeproj -scheme "$SCHEME" -configuration Release -sdk iphoneos \
      -archivePath "$ROOT/build/App.xcarchive" archive \
      DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
      > /tmp/bolloon-archive.log 2>&1; then
  tail -20 /tmp/bolloon-archive.log
  echo
  echo "❌ 归档失败。若上面出现 'has no devices from which to generate a provisioning profile':"
  echo "   · 免费个人开发者账号必须先在团队里登记至少 1 台设备"
  echo "   · 做法: iPhone 用数据线连 Mac → 手机上点「信任」→ 打开 Xcode ▸ Window ▸ Devices and Simulators"
  echo "           → 左侧选中该 iPhone (会显示 'Register Device' 或已自动登记), 然后重跑本脚本"
  echo "   · 或把 UDID 交给脚本:  DEVICE_UDID=<UDID> bash scripts/ios-release.sh"
  exit 1
fi
echo "   归档 OK: build/App.xcarchive"

# ---- ③ 导出 .ipa ----
# METHOD=development (免费个人账号, 仅自己登记的设备) | adhoc (付费账号, 最多 100 台设备, 朋友需提供 UDID)
METHOD="${METHOD:-development}"
OPTS="$ROOT/ios/ExportOptions.plist"
if [ "$METHOD" = "adhoc" ]; then
  OPTS="$ROOT/build/ExportOptions.adhoc.plist"
  sed 's|<string>development</string>|<string>ad-hoc</string>|' "$ROOT/ios/ExportOptions.plist" > "$OPTS"
fi
echo "③ 导出 .ipa (method=$METHOD)…"
xcodebuild -exportArchive -archivePath "$ROOT/build/App.xcarchive" \
  -exportOptionsPlist "$OPTS" \
  -exportPath "$ROOT/build/ipa" -allowProvisioningUpdates > /tmp/bolloon-export.log 2>&1 || {
    tail -20 /tmp/bolloon-export.log; echo "❌ 导出失败"; exit 1; }
IPA="$(ls "$ROOT"/build/ipa/*.ipa 2>/dev/null | head -1 || true)"
[ -n "$IPA" ] || { tail -20 /tmp/bolloon-export.log; echo "❌ 未产出 .ipa"; exit 1; }
echo "   IPA: $IPA ($(du -h "$IPA" | cut -f1))"

if [ "${SKIP_PUBLISH:-0}" = "1" ]; then
  echo "⏭  仅出包 (SKIP_PUBLISH=1), 未上传/未改站点"
  exit 0
fi

# ---- ④ 上传 GitHub Release (IPA 走 Release 资产, 不进 git) ----
echo "④ 上传到 $UI_REPO Release ($TAG)…"
if ! gh release view "$TAG" --repo "$UI_REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$UI_REPO" \
    --title "Bolloon iOS $VER" \
    --notes "Bolloon iOS 开发版 $VER (bundle: com.bolloon.agent)

OTA 安装: ${PAGES_URL}/install.html  →  手机 · iOS  →  安装 iOS App

注意: 个人开发者账号(免费)签名的开发版 — 仅已登记 UDID 的设备可安装, 描述文件 7 天后过期."
fi
gh release upload "$TAG" "$IPA#$APP_NAME.ipa" --repo "$UI_REPO" --clobber
echo "   资产: https://github.com/$UI_REPO/releases/download/$TAG/$APP_NAME.ipa"

# ---- ⑤ 更新 bolloon-UI 安装清单并发布 (Pages 从 main 自动构建) ----
echo "⑤ 更新 bolloon-UI 安装清单…"
[ -d "$UI_DIR" ] || { echo "❌ 找不到 bolloon-UI ($UI_DIR) — 用 BOLLOON_UI_DIR=… 指定"; exit 1; }
python3 - "$UI_DIR" "$VER" "$TAG" <<'PY'
import sys, re, pathlib
ui, ver, tag = sys.argv[1], sys.argv[2], sys.argv[3]
mp = pathlib.Path(ui) / 'ios' / 'manifest.plist'
s = mp.read_text(encoding='utf-8')
s = re.sub(r'releases/download/[^/]+/', 'releases/download/%s/' % tag, s)
s = re.sub(r'(<key>bundle-version</key>\s*<string>)[^<]*(</string>)', r'\g<1>%s\g<2>' % ver, s)
mp.write_text(s, encoding='utf-8')
ip = pathlib.Path(ui) / 'install.html'
h = ip.read_text(encoding='utf-8')
h = re.sub(r'(<span class="intro-note" id="ios-note">)[^<]*(</span>)',
           r'\g<1>开发版签名 · 需已登记设备 · v%s\g<2>' % ver, h)
h = re.sub(r'(id="ios-version"[^>]*>)', r'\g<1>当前版本 v%s · 发布 %s' % (ver, tag), h)
ip.write_text(h, encoding='utf-8')
print('   manifest.plist + install.html 已更新')
PY
( cd "$UI_DIR" && git add install.html ios/manifest.plist \
  && { git diff --cached --quiet || git commit -m "ios: 发布 v$VER OTA 安装入口 (manifest + 安装页 iOS 栏目)"; } \
  && git push origin main )

echo
echo "✅ 完成"
echo "   安装页 (iPhone 用 Safari 打开): ${PAGES_URL}/install.html"
echo "   IPA: https://github.com/$UI_REPO/releases/download/$TAG/$APP_NAME.ipa"
echo "   Pages 构建需 1-3 分钟; 若安装页 404 稍等再试"
