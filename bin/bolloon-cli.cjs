#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";

function log(msg, color) {
  console.log((color || RESET) + msg + RESET);
}

function printBanner() {
  console.log("\n" + CYAN + BOLD + [
    "   ╔═══════════════════════════════════════════╗",
    "   ║      🤖 Bolloon Agent                     ║",
    "   ║      P2P AI Document Processor            ║",
    "   ╚═══════════════════════════════════════════╝"
  ].join("\n") + RESET + "\n");
}

function getMainEntry() {
  // bin is in: node_modules/.bin/bolloon
  // package is in: node_modules/@bolloon/bolloon-agent/
  // dist is in: node_modules/@bolloon/bolloon-agent/dist/
  const binPath = require.main.filename; // /tmp/node_modules/.bin/bolloon
  const binDir = path.dirname(binPath); // /tmp/node_modules/.bin
  const packageDir = path.dirname(binDir); // /tmp/node_modules/@bolloon/bolloon-agent
  // 优先用 package.json 'main' 字段 (v0.2.3+ 指向 dist/cli-entry.js).
  // 真实 npm 安装用户拿到的是编译后的 dist, 不该再依赖 tsx.
  const pkgJsonPath = path.join(packageDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.main) {
        const mainPath = path.join(packageDir, pkg.main);
        if (fs.existsSync(mainPath)) return mainPath;
      }
    } catch {}
  }
  // fallback: 兼容老版本 (dist/index.js 是之前默认)
  const distIndex = path.join(packageDir, "dist", "index.js");
  if (fs.existsSync(distIndex)) return distIndex;
  // 最后才 fallback 到 src (开发环境)
  return path.join(packageDir, "src", "index.ts");
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
    const binPath = require.main.filename;
    const binDir = path.dirname(binPath);
    const packageDir = path.dirname(binDir);
    let mainPath = path.join(packageDir, "dist", "electron.js");
    if (!fs.existsSync(mainPath)) {
      mainPath = path.join(packageDir, "src", "electron.ts");
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
  // Get version from package.json
  const binPath = require.main.filename;
  const binDir = path.dirname(binPath);
  const packageDir = path.dirname(binDir);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
  const version = packageJson.version;

  const { mode, args } = parseArgs();
  switch (mode) {
    case "version":
      console.log("Bolloon Agent v" + version);
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
