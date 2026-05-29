/**
 * CLI 构建脚本
 *
 * 生成 bin/bolloon.js 和 bin/bolloon.cmd 入口文件
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const binDir = path.join(rootDir, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// Windows 批处理入口
const winContent = `@echo off
set "BOLLOON_ROOT=%~dp0"
set "BOLLOON_ROOT=%BOLLOON_ROOT:~0,-1%"

REM 确定入口文件
set "ENTRY=%BOLLOON_ROOT%\\dist\\index.js"
if not exist "%ENTRY%" (
    set "ENTRY=%BOLLOON_ROOT%\\src\\index.ts"
)

node "%ENTRY%" %*
`;

fs.writeFileSync(path.join(binDir, 'bolloon.cmd'), winContent);

// Unix/Linux/Mac 入口脚本
const unixContent = `#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const RESET = "\\x1b[0m";
const BOLD = "\\x1b[1m";
const CYAN = "\\x1b[36m";
const GREEN = "\\x1b[32m";
const MAGENTA = "\\x1b[35m";

function log(msg, color) {
  console.log((color || RESET) + msg + RESET);
}

function printBanner() {
  console.log("\\n" + CYAN + BOLD + [
    "   ╔═══════════════════════════════════════════╗",
    "   ║      🤖 Bolloon Agent                     ║",
    "   ║      P2P AI Document Processor            ║",
    "   ╚═══════════════════════════════════════════╝"
  ].join("\\n") + RESET + "\\n");
}

function getMainEntry() {
  const distDir = path.dirname(require.main.filename);
  const distIndex = path.join(distDir, "index.js");
  if (fs.existsSync(distIndex)) {
    return distIndex;
  }
  return path.join(process.cwd(), "src", "index.ts");
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return { mode: "gui", args: [] };
  }
  const first = args[0];
  switch (first) {
    case "-v":
    case "--version":
      return { mode: "version", args: [] };
    case "-h":
    case "--help":
      return { mode: "help", args: [] };
    case "-g":
    case "--gui":
      return { mode: "gui", args: args.slice(1) };
    case "-w":
    case "--web":
      return { mode: "web", args: args.slice(1) };
    case "-c":
    case "--cli":
      return { mode: "cli", args: args.slice(1) };
    default:
      return { mode: "passthrough", args };
  }
}

async function startElectron(additionalArgs) {
  try {
    const electron = require("electron");
    const distDir = path.dirname(require.main.filename);
    let mainPath = path.join(distDir, "electron.js");
    if (!fs.existsSync(mainPath)) {
      mainPath = path.join(process.cwd(), "src", "electron.ts");
    }
    log("启动 Electron...", CYAN);
    const child = spawn(electron, [mainPath, ...additionalArgs], {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" }
    });
    child.on("error", (err) => {
      log("Electron 启动失败: " + err.message, MAGENTA);
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code || 0));
  } catch (err) {
    log("Electron 不可用，切换到 Web 模式...", CYAN);
    await startWebServer(additionalArgs);
  }
}

async function startWebServer(additionalArgs) {
  const mainPath = getMainEntry();
  const webArgs = ["--web", ...additionalArgs];
  log("启动 Web 服务...", CYAN);
  const child = spawn(process.execPath, [mainPath, ...webArgs], { stdio: "inherit" });
  child.on("error", (err) => {
    log("Web 服务启动失败: " + err.message, MAGENTA);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code || 0));
}

async function startCLI(additionalArgs) {
  const mainPath = getMainEntry();
  log("启动命令行界面...", CYAN);
  const child = spawn(process.execPath, [mainPath, ...additionalArgs], { stdio: "inherit" });
  child.on("error", (err) => {
    log("CLI 启动失败: " + err.message, MAGENTA);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code || 0));
}

async function main() {
  const { mode, args } = parseArgs();
  switch (mode) {
    case "version":
      console.log("Bolloon Agent v0.1.1");
      break;
    case "help":
      printBanner();
      console.log(BOLD + "用法:" + RESET + "  bolloon [选项] [命令] [参数]");
      console.log(BOLD + "选项:" + RESET + "  --gui, -g           启动图形界面");
      console.log("         --web, -w           启动 Web UI");
      console.log("         --cli, -c           启动命令行界面");
      console.log("         --version, -v       显示版本");
      console.log("         --help, -h          显示帮助");
      console.log(BOLD + "示例:" + RESET + "  bolloon              # 启动图形界面");
      console.log("         bolloon --web        # 启动 Web UI");
      console.log("         bolloon --read file  # 读取文档");
      break;
    case "gui":
      printBanner();
      await startElectron(args);
      break;
    case "web":
      printBanner();
      await startWebServer(args);
      break;
    case "cli":
      await startCLI(args);
      break;
    case "passthrough":
      const mainPath = getMainEntry();
      const child = spawn(process.execPath, [mainPath, ...args], { stdio: "inherit" });
      child.on("error", (err) => {
        log("执行失败: " + err.message, MAGENTA);
        process.exit(1);
      });
      child.on("exit", (code) => process.exit(code || 0));
      break;
    default:
      log("未知模式: " + mode, MAGENTA);
      printBanner();
      console.log("输入 --help 查看帮助");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
`;

fs.writeFileSync(path.join(binDir, 'bolloon.cjs'), unixContent);

// 确保 bin/bolloon.js 存在（npm link 需要）
const jsSymlink = path.join(binDir, 'bolloon.js');
if (fs.existsSync(jsSymlink)) fs.unlinkSync(jsSymlink);
fs.symlinkSync('bolloon.cjs', jsSymlink);

console.log("✓ CLI 构建完成");
console.log("  bin/bolloon.cjs    - CommonJS 入口");
console.log("  bin/bolloon.js     - 符号链接 -> bolloon.cjs");
console.log("  bin/bolloon.cmd    - Windows 入口");