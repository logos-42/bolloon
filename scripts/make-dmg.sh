#!/bin/bash
# 手搓 macOS DMG「拖到应用程序文件夹」安装窗 —— 品牌化 (lime #EEFA06 背景 + 应用图标 + 应用程序文件夹快捷方式)
# 不依赖 create-dmg (npm 简化版不支持自定义背景); 直接用 hdiutil + osascript, 本地与 CI 都可靠.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: make-dmg.sh <App.app> <output.dmg> [background.png]" >&2
  exit 1
fi

APP="$1"
DMG="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BG="${3:-$SCRIPT_DIR/../build/dmg-background.png}"

APP_NAME="$(basename "$APP" .app)"
VOL_NAME="$APP_NAME"
OUT_DIR="$(dirname "$DMG")"
TMP_RW="$OUT_DIR/rw-$VOL_NAME.dmg"

[ -d "$APP" ] || { echo "ERROR: app 未找到: $APP" >&2; exit 1; }
[ -f "$BG" ]  || { echo "ERROR: 背景图未找到: $BG" >&2; exit 1; }

cleanup() { [ -n "${DEV:-}" ] && hdiutil detach "$DEV" -force 2>/dev/null || true; }
trap cleanup EXIT

echo "==> 创建可读写镜像"
rm -f "$TMP_RW"
hdiutil create -srcfolder "$APP" -volname "$VOL_NAME" -fs HFS+ -format UDRW "$TMP_RW"

echo "==> 挂载"
DEV="$(hdiutil attach -readwrite -noverify -noautoopen "$TMP_RW" | grep -E '^/dev/' | head -1 | awk '{print $1}')"
MOUNT="$(mount | grep "$DEV" | sed -E 's#^.* on (.*) \(.*#\1#')"
echo "    dev=$DEV  mount=$MOUNT"

echo "==> 放入品牌背景 + 应用程序文件夹快捷方式"
mkdir -p "$MOUNT/.background"
cp "$BG" "$MOUNT/.background/background.png"
ln -sf /Applications "$MOUNT/Applications"

echo "==> 通过 Finder 设置窗口/图标布局"
osascript <<EOF
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {400, 200, 1058, 698}
    set theViewOptions to the icon view options of container window
    set icon size of theViewOptions to 128
    set arrangement of theViewOptions to not arranged
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "$APP_NAME.app" of container window to {140, 249}
    set position of item "Applications" of container window to {518, 249}
    update without registering applications
    delay 3
    close
  end tell
end tell
EOF

echo "==> 卸载并压缩为只读 DMG"
hdiutil detach "$DEV" || hdiutil detach "$DEV" -force
rm -f "$DMG"
hdiutil convert "$TMP_RW" -format UDZO -imagekey zlib-level=9 -o "$DMG"
rm -f "$TMP_RW"
echo "==> 完成: $DMG ($(du -h "$DMG" | cut -f1))"
