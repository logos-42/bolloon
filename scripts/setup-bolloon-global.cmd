@echo off
REM ==========================================================================
REM Bolloon one-shot global install (Windows)
REM Use: run `cmd /c scripts\setup-bolloon-global.cmd` from the repo root,
REM      or double-click from Explorer. Idempotent.
REM ==========================================================================

setlocal

set "REPO_ROOT=%~dp0.."

if not exist "%REPO_ROOT%\package.json" (
    echo [ERROR] package.json not found in %REPO_ROOT%
    exit /b 1
)

pushd "%REPO_ROOT%"

echo.
echo === Bolloon one-shot global install ===
echo Repo:  %CD%
echo User:  %USERNAME%
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not in PATH. Please install Node.js 18+ first.
    popd
    exit /b 1
)

REM 1. Skip npm install if node_modules exists (postinstall already ran)
if not exist "node_modules" (
    echo [step] npm install ^(first time, ~60s+^)...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        popd
        exit /b 1
    )
) else (
    echo [skip] node_modules exists, skipping npm install
)

REM 2. Global link - this is the line that makes `bolloon` work
echo.
echo [step] npm install -g .  ^(creates %APPDATA%\npm\bolloon.cmd ^)
call npm install -g .
if errorlevel 1 (
    echo [ERROR] npm install -g . failed.
    echo         Common cause: EACCES. Try running in an Admin PowerShell.
    popd
    exit /b 1
)

REM 3. Verify
echo.
echo [verify] bolloon --version
where bolloon >nul 2>nul
if errorlevel 1 (
    echo [WARN] bolloon not in current PATH. shim created; restart PowerShell.
) else (
    call bolloon --version
)

echo.
echo === Done ===
echo You can now run:
echo   bolloon              GUI
echo   bolloon --web        Web UI
echo   bolloon --cli        CLI mode
echo   bolloon --help       help
echo.

popd
endlocal
exit /b 0
