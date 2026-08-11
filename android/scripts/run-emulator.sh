#!/bin/bash
# 启动 AVD → 安装 APK → 启动 MainActivity → 截图 (Bolloon Android 独立 APP 渲染验证)
# 注意: adb.exe 是 Windows 二进制, 路径参数必须用 Windows 风格 (D:/...), MSYS /d/... 会 stat 失败。
set -x
SDK=/c/tools/android-sdk
APK='D:/AI/bolloon/android/app/build/outputs/apk/debug/app-debug.apk'
OUT=/d/AI/bolloon/android/captures
mkdir -p "$OUT"

# 1. 启动 AVD (WHPX CPU 加速, swiftshader GPU, 无快照冷启动)
"$SDK/emulator/emulator.exe" -avd Medium_Phone_API_36.1 \
  -no-snapshot -no-audio -no-boot-anim -gpu swiftshader_indirect \
  > "$OUT/emulator.log" 2>&1 &
EMU_PID=$!
echo "emulator pid=$EMU_PID"

# 2. 等待设备就绪 (boot completed, 最长 10 分钟)
"$SDK/platform-tools/adb.exe" wait-for-device
for i in $(seq 1 120); do
  BOOT=$("$SDK/platform-tools/adb.exe" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$BOOT" = "1" ]; then echo "boot completed after ${i}0s"; break; fi
  sleep 10
done

# 3. 安装 APK
"$SDK/platform-tools/adb.exe" install -r "$APK" || exit 1

# 4. 启动 MainActivity
"$SDK/platform-tools/adb.exe" shell am start -n com.bolloon.agent.rokid/.MainActivity || exit 1
sleep 8

# 5. 截图
"$SDK/platform-tools/adb.exe" exec-out screencap -p > "$OUT/app-render.png"
echo "screenshot: $OUT/app-render.png"
"$SDK/platform-tools/adb.exe" shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'" 
