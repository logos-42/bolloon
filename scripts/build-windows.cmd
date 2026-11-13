@echo off
REM ============================================================================
REM  Windows 端从源码构建 bolloon（带跨机互联 features）
REM
REM  npm 包目前只随附 macOS 的两个原生二进制，Windows 装完包会提示
REM  "本包没有 win32-x64 的原生二进制"。此脚本在 Windows 本机编译出
REM  rust\target\release\bolloon.exe，并告诉你如何指给 npm 入口。
REM
REM  前提: rustup + stable 工具链 (rustc 1.99+), git, 能访问 crates.io。
REM  用法: 在仓库根目录运行  scripts\build-windows.cmd
REM ============================================================================
setlocal
cd /d "%~dp0..\rust" || (echo [ERROR] 找不到 rust 目录 & exit /b 1)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 没找到 cargo。先安装 Rust: https://rustup.rs
  exit /b 1
)

echo.
echo === cargo build --release -p bolloon-cli --features diap-backend,dht-backend ===
echo     (首次构建 iroh / libp2p / arkworks 会较久，请耐心等待)
cargo build --release -p bolloon-cli --features diap-backend,dht-backend
if errorlevel 1 (
  echo [ERROR] 构建失败；把完整报错发回来处理。
  exit /b 1
)

set "BIN=%CD%\target\release\bolloon.exe"
echo.
echo [OK] 产物: %BIN%
"%BIN%" --version
echo.
echo === 让 npm 入口使用这个二进制 ===
echo   当前窗口:  set BOLLOON_NATIVE_BIN=%BIN%
echo   永久设置:  setx BOLLOON_NATIVE_BIN "%BIN%"
echo.
echo === 启动跨机节点 (PowerShell) ===
echo   $env:BOLLOON_BIND="0.0.0.0"
echo   $env:BOLLOON_PUBLIC_URL="http://^<本机IP^>:54188"
echo   $env:BOLLOON_DIAP="1"
echo   $env:BOLLOON_DHT="1"
echo   $env:BOLLOON_DHT_PORT="54931"
echo   $env:BOLLOON_DHT_BOOTSTRAP="/ip4/^<bootstrap-IP^>/tcp/54931/p2p/^<peer_id^>"
echo   "%BIN%" web --port 54188
echo.
echo 拿本机 DIAP 地址给对方: curl http://127.0.0.1:54188/api/diap/addr
echo 只输对方手机号连上:      POST /api/contacts/connect {"query":"<对方手机号>","kind":"phone"}
echo.
endlocal
