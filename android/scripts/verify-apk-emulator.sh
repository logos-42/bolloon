#!/bin/bash
# 重新打包后的 APK 渲染验证: 启动 AVD → 装 APK → 起 MainActivity → uiautomator 文本取证 + crash buffer 检查
# 用法: bash android/scripts/verify-apk-emulator.sh [APK路径]
# 注意: adb.exe/emulator.exe 是 Windows 二进制, 路径参数必须 Windows 风格 (D:/...), MSYS /d/... 会 stat 失败。
set -x
SDK=/c/tools/android-sdk
ADB="$SDK/platform-tools/adb.exe"
APK="${1:-D:/AI/bolloon/android/app/build/outputs/apk/debug/bolloon-0.4.20.apk}"
PKG=com.bolloon.agent.rokid
OUT=/d/AI/bolloon/android/captures
mkdir -p "$OUT"

# 1. 若无设备则启动 AVD (WHPX 加速, swiftshader GPU, 冷启动)
if ! "$ADB" devices | grep -q "emulator.*device$"; then
  "$SDK/emulator/emulator.exe" -avd Medium_Phone_API_36.1 \
    -no-snapshot -no-audio -no-boot-anim -gpu swiftshader_indirect \
    > "$OUT/emulator.log" 2>&1 &
  echo "emulator pid=$!"
fi

# 2. 等待 boot completed (最长 10 分钟)
"$ADB" wait-for-device
BOOT=""
for i in $(seq 1 60); do
  BOOT=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$BOOT" = "1" ] && { echo "boot completed after ~$((i*10))s"; break; }
  sleep 10
done
[ "$BOOT" = "1" ] || { echo "BOOT TIMEOUT"; exit 2; }

# 3. 清日志 + 装 APK
"$ADB" logcat -c 2>/dev/null
"$ADB" install -r "$APK" || exit 3

# 4. 启动 MainActivity
"$ADB" shell am start -n "$PKG/.MainActivity" || exit 4
sleep 12

# 5. 取证 A: 前台 Activity
echo "=== topResumedActivity ==="
"$ADB" shell "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'"

# 6. 取证 B: uiautomator 文本 (WebView 真实渲染文本 = 硬证据)
"$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
# adb.exe 是 Windows 二进制: 目标路径必须 Windows 风格 (MSYS /d/... 会静默失败)
"$ADB" pull /sdcard/ui.xml "D:/AI/bolloon/android/captures/ui.xml" >/dev/null 2>&1
echo "=== ui.xml 文本节点 (前 30 条) ==="
python - "D:/AI/bolloon/android/captures/ui.xml" <<'PY'
import re, sys
try:
    xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
except OSError as e:
    print('ui.xml 缺失:', e); sys.exit(0)
texts = [t for t in re.findall(r'text="([^"]*)"', xml) if t.strip()]
print(f'文本节点数={len(texts)}')
for t in texts[:30]:
    print(' -', t)
PY

# 7. 取证 C: 进程存活 + crash buffer
echo "=== 进程 ==="
"$ADB" shell "ps -A | grep bolloon"
echo "=== crash buffer (最近) ==="
"$ADB" logcat -d -b crash 2>/dev/null | tail -20
echo "=== 截图 ==="
"$ADB" exec-out screencap -p > "$OUT/app-render-0.4.20.png"
ls -la "$OUT/app-render-0.4.20.png"
echo "VERIFY_DONE"
