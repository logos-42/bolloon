/**
 * CLI 构建脚本
 *
 * 将 TypeScript CLI 入口编译为可执行的 JavaScript，
 * 并创建 bin/bolloon.js 入口点
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// 确保 bin 目录存在
const binDir = path.join(rootDir, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// CLI 入口内容 - 使用普通字符串拼接避免模板问题
const cliContent = [
  '#!/usr/bin/env node',
  '/**',
  ' * Bolloon CLI 入口',
  ' * 自动选择合适的启动方式',
  ' */',
  '',
  'const path = require("path");',
  'const { spawn } = require("child_process");',
  '',
  '// 获取 dist 目录',
  'const distDir = path.dirname(require.main.filename);',
  'const isDev = process.env.NODE_ENV === "development";',
  '',
  '// ANSI 颜色',
  'const RESET = "\\x1b[0m";',
  'const BOLD = "\\x1b[1m";',
  'const CYAN = "\\x1b[36m";',
  'const GREEN = "\\x1b[32m";',
  'const MAGENTA = "\\x1b[35m";',
  '',
  'function log(msg, color) {',
  '  console.log((color || RESET) + msg + RESET);',
  '}',
  '',
  'function printBanner() {',
  '  console.log("\\n" + CYAN + BOLD +',
  '    "   ╔═══════════════════════════════════════════╗\\n" +',
  '    "   ║      🤖 Bolloon Agent                     ║\\n" +',
  '    \'   ║      P2P AI Document Processor            ║\\n" +\',',
  '    \'   ╚═══════════════════════════════════════════╝\\n" + RESET + "\\n");',
  '}',
  '',
  'function getMainEntry() {',
  '  // 优先使用编译后的 dist/index.js',
  '  const distIndex = path.join(distDir, "index.js");',
  '  if (fs.existsSync(distIndex)) {',
  '    return distIndex;',
  '  }',
  '  // 回退到开发模式',
  '  return path.join(process.cwd(), "src", "index.ts");',
  '}',
  '',
  'function parseArgs() {',
  '  const args = process.argv.slice(2);',
  '  if (args.length === 0) {',
  '    return { mode: "gui", args: [] };',
  '  }',
  '  const first = args[0];',
  '  switch (first) {',
  '    case "-v":',
  '    case "--version":',
  '      return { mode: "version", args: [] };',
  '    case "-h":',
  '    case "--help":',
  '      return { mode: "help", args: [] };',
  '    case "-g":',
  '    case "--gui":',
  '      return { mode: "gui", args: args.slice(1) };',
  '    case "-w":',
  '    case "--web":',
  '      return { mode: "web", args: args.slice(1) };',
  '    case "-c":',
  '    case "--cli":',
  '      return { mode: "cli", args: args.slice(1) };',
  '    default:',
  '      return { mode: "passthrough", args };',
  '  }',
  '}',
  '',
  'async function startElectron(additionalArgs) {',
  '  try {',
  '    const electron = require("electron");',
  '    let mainPath = path.join(distDir, "electron.js");',
  '    if (!fs.existsSync(mainPath)) {',
  '      mainPath = path.join(process.cwd(), "src", "electron.ts");',
  '    }',
  '    log("启动 Electron...", CYAN);',
  '    const child = spawn(electron, [mainPath, ...additionalArgs], {',
  '      stdio: "inherit",',
  '      env: { ...process.env, NODE_ENV: "development" }',
  '    });',
  '    child.on("error", (err) => {',
  '      log("Electron 启动失败: " + err.message, MAGENTA);',
  '      process.exit(1);',
  '    });',
  '    child.on("exit", (code) => process.exit(code || 0));',
  '  } catch (err) {',
  '    log("Electron 不可用，切换到 Web 模式...", CYAN);',
  '    await startWebServer(additionalArgs);',
  '  }',
  '}',
  '',
  'async function startWebServer(additionalArgs) {',
  '  const mainPath = getMainEntry();',
  '  const webArgs = ["--web", ...additionalArgs];',
  '  log("启动 Web 服务...", CYAN);',
  '  const child = spawn(process.execPath, [mainPath, ...webArgs], { stdio: "inherit" });',
  '  child.on("error", (err) => {',
  '    log("Web 服务启动失败: " + err.message, MAGENTA);',
  '    process.exit(1);',
  '  });',
  '  child.on("exit", (code) => process.exit(code || 0));',
  '}',
  '',
  'async function startCLI(additionalArgs) {',
  '  const mainPath = getMainEntry();',
  '  log("启动命令行界面...", CYAN);',
  '  const child = spawn(process.execPath, [mainPath, ...additionalArgs], { stdio: "inherit" });',
  '  child.on("error", (err) => {',
  '    log("CLI 启动失败: " + err.message, MAGENTA);',
  '    process.exit(1);',
  '  });',
  '  child.on("exit", (code) => process.exit(code || 0));',
  '}',
  '',
  'async function main() {',
  '  const { mode, args } = parseArgs();',
  '  switch (mode) {',
  '    case "version":',
  '      console.log("Bolloon Agent v0.1.1");',
  '      break;',
  '    case "help":',
  '      printBanner();',
  '      console.log(BOLD + "用法:" + RESET);',
  '      console.log("  bolloon [选项] [命令] [参数]\\n");',
  '      console.log(BOLD + "选项:" + RESET);',
  '      console.log("  --gui, -g           启动图形界面 (Electron)");',
  '      console.log("  --web, -w           启动 Web UI (浏览器)");',
  '      console.log("  --cli, -c           启动命令行界面");',
  '      console.log("  --version, -v       显示版本信息");',
  '      console.log("  --help, -h          显示帮助信息\\n");',
  '      console.log(BOLD + "示例:" + RESET);',
  '      console.log("  bolloon              # 启动图形界面");',
  '      console.log("  bolloon --web        # 启动 Web UI");',
  '      console.log("  bolloon --read file  # 读取文档");',
  '      console.log("  bolloon --cli        # 命令行模式");',
  '      break;',
  '    case "gui":',
  '      printBanner();',
  '      await startElectron(args);',
  '      break;',
  '    case "web":',
  '      printBanner();',
  '      await startWebServer(args);',
  '      break;',
  '    case "cli":',
  '      await startCLI(args);',
  '      break;',
  '    case "passthrough":',
  '      const mainPath = getMainEntry();',
  '      const child = spawn(process.execPath, [mainPath, ...args], { stdio: "inherit" });',
  '      child.on("error", (err) => {',
  '        log("执行失败: " + err.message, MAGENTA);',
  '        process.exit(1);',
  '      });',
  '      child.on("exit", (code) => process.exit(code || 0));',
  '      break;',
  '    default:',
  '      log("未知模式: " + mode, MAGENTA);',
  '      printBanner();',
  '      console.log("输入 --help 查看帮助");',
  '      process.exit(1);',
  '  }',
  '}',
  '',
  'main().catch((err) => {',
  '  console.error("Fatal error:", err);',
  '  process.exit(1);',
  '});',
].join('\n');

// 写入 bin/bolloon.js
fs.writeFileSync(path.join(binDir, 'bolloon.js'), cliContent, { encoding: 'utf-8' });

// Windows .cmd 入口
const cmdContent = `@echo off
setlocal EnableDelayedExpansion

REM Bolloon CLI Windows 入口
set "BOLLOON_ROOT=%~dp0"
set "BOLLOON_ROOT=%BOLLOON_ROOT:~0,-1%"
set "BOLLOON_DIST=%BOLLOON_ROOT%\\dist"

REM 获取 node 路径
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo 错误: 未找到 node 命令，请确保 Node.js 已安装
    exit /b 1
)

REM 确定入口
set "ENTRY=%BOLLOON_DIST%\\index.js"
if not exist "%ENTRY%" (
    set "ENTRY=%BOLLOON_ROOT%\\src\\index.ts"
)

REM 传递所有参数
node "%ENTRY%" %*
`;

fs.writeFileSync(path.join(binDir, 'bolloon.cmd'), cmdContent, { encoding: 'utf-8' });

console.log('✓ CLI 构建完成');
console.log('  bin/bolloon.js     - Unix/Mac/Linux 入口');
console.log('  bin/bolloon.cmd    - Windows 入口');