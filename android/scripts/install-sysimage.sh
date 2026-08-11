#!/bin/bash
# 安装 android-36.1 google_apis_playstore x86_64 system image (供 AVD Medium_Phone_API_36.1)
export JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot'
LOG=/tmp/sdk-image-install2.log
echo "=== start $(date '+%F %T') ===" > "$LOG"
yes | /c/tools/android-sdk/cmdline-tools/latest/cmdline-tools/bin/sdkmanager.bat \
  --sdk_root=C:\\tools\\android-sdk \
  "system-images;android-36.1;google_apis_playstore;x86_64" >> "$LOG" 2>&1
RC=$?
echo "=== EXIT=$RC $(date '+%F %T') ===" >> "$LOG"
exit $RC
