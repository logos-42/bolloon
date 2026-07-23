#!/usr/bin/env node
/**
 * Bolloon CLI 入口
 *
 * 使用方式:
 *   bolloon                    # 启动 GUI（Electron 或 Web）
 *   bolloon --cli              # 启动命令行界面
 *   bolloon --read <file>      # 读取文档
 *   bolloon --summarize <file> # 总结文档
 *   bolloon --web              # 启动 Web UI
 *   bolloon --version          # 显示版本
 *   bolloon engine list        # 列出外部编码智能体
 *   bolloon engine run <prompt> --engine opencode --model opencode/deepseek-v4-flash-free  # 委派任务
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { printBanner } from './cli/loading-tui.js';
import { discoverEngines, delegateToEngine } from './external-engines/index.js';

const isWindows = process.platform === 'win32';

// ANSI 颜色
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';

// 版本信息 — 2026-07-20 Bug 3: 从 package.json 读取, 不再硬编码
const VERSION = ((): string => {
  try {
    const entryDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(entryDir, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function log(msg: string, color: string = RESET) {
  console.log(`${color}${msg}${RESET}`);
}

function printBannerCli() {
  printBanner(VERSION);
}

function printHelp() {
  console.log(`
${BOLD}用法:${RESET}
  bolloon [选项] [命令] [参数]

${BOLD}选项:${RESET}
  --gui, -g           启动图形界面 (Electron)
  --web, -w           启动 Web UI (浏览器)
  --cli, -c           启动命令行界面
  --version, -v       显示版本信息
  --help, -h          显示帮助信息

${BOLD}命令:${RESET}
  bolloon --read <file>           读取文档
  bolloon --summarize <file>      总结文档
  bolloon --improve <file> <req>  改进文档

${BOLD}示例:${RESET}
  bolloon                    # 启动图形界面
  bolloon --web              # 启动 Web UI
  bolloon --read 想法.md     # 读取文档
  bolloon --cli              # 命令行模式

${BOLD}环境变量:${RESET}
  MINIMAX_API_KEY           MiniMax API 密钥
  OPENAI_API_KEY            OpenAI API 密钥
  ANTHROPIC_API_KEY         Anthropic API 密钥
  PORT                      Web 服务端口 (默认 54188)
`);
}

function getDistDir(): string {
  // 2026-07-01: ESM 模块无 __dirname, 用 import.meta.url + path.dirname 拿当前文件所在目录.
  // 对于打包后的应用, 这是 dist 目录; 对于 tsx 跑 src/index.ts 时, 是 src/ 目录
  // (后续 getMainScript 会优先用 dist/cli-entry.js, 不依赖这里的返回值)
  const __filename_esm = fileURLToPath(import.meta.url);
  return path.dirname(__filename_esm);
}

function getMainScript(): string {
  const distDir = getDistDir();

  // 检查 dist/index.js 是否存在
  const indexPath = path.join(distDir, 'index.js');
  if (fs.existsSync(indexPath)) {
    return indexPath;
  }

  // 回退到源目录
  const srcPath = path.join(process.cwd(), 'src', 'index.ts');
  if (fs.existsSync(srcPath)) {
    return path.join(process.cwd(), 'src', 'index.ts');
  }

  throw new Error('找不到入口脚本，请确保已执行 npm run build');
}

function getElectronPath(): string {
  // 获取 electron 可执行文件路径
  const electronPath = require('electron');
  return electronPath;
}

// 解析命令行参数
function parseArgs(): { mode: string; args: string[] } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    return { mode: 'gui', args: [] };
  }

  const mode = args[0];

  // 处理简写选项
  switch (mode) {
    case '-v':
    case '--version':
      return { mode: 'version', args: [] };
    case '-h':
    case '--help':
      return { mode: 'help', args: [] };
    case '-g':
    case '--gui':
      return { mode: 'gui', args: args.slice(1) };
    case '-w':
    case '--web':
      return { mode: 'web', args: args.slice(1) };
    case '-c':
    case '--cli':
      return { mode: 'cli', args: args.slice(1) };
    case 'engine':
      return { mode: 'engine', args: args.slice(1) };
    default:
      // 传递所有参数给主程序
      return { mode: 'passthrough', args };
  }
}

/** 引擎子命令: list / run */
async function handleEngineCommand(engineArgs: string[]): Promise<void> {
  if (engineArgs.length === 0) {
    console.log(`${BOLD}用法:${RESET}`);
    console.log('  bolloon engine list                        # 列出外部编码智能体');
    console.log('  bolloon engine run <prompt> [options]       # 委派任务给智能体');
    console.log('');
    console.log(`${BOLD}选项 (run):${RESET}`);
    console.log('  --engine <id>   引擎 id (默认 opencode)');
    console.log('  --model <name>  指定模型 (如 opencode/deepseek-v4-flash-free)');
    return;
  }

  const sub = engineArgs[0];

  if (sub === 'list') {
    const engines = await discoverEngines();
    console.log(`\n${BOLD}外部编码智能体:${RESET}`);
    console.log('─'.repeat(60));
    for (const e of engines) {
      const status = e.available ? `${GREEN}✅ 可用${RESET}` : e.configured ? `${YELLOW}⚠ 已配置${RESET}` : e.installed ? `${YELLOW}⚠ 未配置${RESET}` : `${MAGENTA}✗ 未安装${RESET}`;
      console.log(`  ${status}  ${e.displayName}`);
      console.log(`       ID: ${e.id}`);
      console.log(`       CLI: ${e.cliPath || '(未安装)'}`);
      console.log(`       Provider: ${e.provider || '(未知)'}`);
      if (e.model) console.log(`       模型: ${e.model}`);
      if (e.apiKey) console.log(`       API Key: ***${e.apiKey.slice(-4)}`);
      if (e.notes) console.log(`       ${e.notes}`);
      console.log('');
    }
    return;
  }

  if (sub === 'run') {
    // 解析子参数: bolloon engine run <prompt> --engine <id> --model <name>
    const rest = engineArgs.slice(1);
    const promptParts: string[] = [];
    let engineId = 'opencode';
    let modelName: string | undefined;
    let cwd: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--engine' && i + 1 < rest.length) {
        engineId = rest[++i];
      } else if (arg === '--model' && i + 1 < rest.length) {
        modelName = rest[++i];
      } else if (arg === '--cwd' && i + 1 < rest.length) {
        cwd = rest[++i];
      } else {
        promptParts.push(arg);
      }
    }

    const prompt = promptParts.join(' ');
    if (!prompt) {
      console.error('错误: 请提供 prompt');
      process.exit(1);
    }

    console.log(`${CYAN}🚀 委派给 ${engineId}${RESET}${modelName ? ` (模型: ${modelName})` : ''}`);
    console.log(`   Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);
    console.log('');

    const result = await delegateToEngine(engineId as any, prompt, {
      model: modelName,
      cwd: cwd || process.cwd(),
    });

    if (result.success) {
      console.log(`${GREEN}✅ 执行成功 (exit: ${result.exitCode})${RESET}`);
      console.log('─'.repeat(40));
      console.log(result.output || '(无输出)');
    } else {
      console.log(`${MAGENTA}❌ 执行失败${RESET}`);
      console.log('─'.repeat(40));
      if (result.error) console.error(`   Error: ${result.error}`);
      if (result.output) console.log(result.output.slice(0, 2000));
      process.exit(result.exitCode ?? 1);
    }
    return;
  }

  console.error(`未知引擎子命令: ${sub}`);
  process.exit(1);
}

// 执行 Node.js 脚本
async function runNodeScript(scriptPath: string, additionalArgs: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...additionalArgs], {
      stdio: 'inherit',
      env: { ...process.env }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`进程退出，代码: ${code}`));
      }
    });
  });
}

// 启动 Electron
async function startElectron(additionalArgs: string[]) {
  const electronPath = getElectronPath();
  const distDir = getDistDir();

  // 确定主进程入口
  let mainPath = path.join(distDir, 'electron.js');
  if (!fs.existsSync(mainPath)) {
    mainPath = path.join(distDir, '..', 'src', 'electron.js');
  }

  if (!fs.existsSync(mainPath)) {
    // 回退到开发模式
    mainPath = path.join(process.cwd(), 'src', 'electron.ts');
  }

  log('启动 Electron...', CYAN);

  const child = spawn(electronPath, [mainPath, ...additionalArgs], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' }
  });

  child.on('error', (err) => {
    log(`Electron 启动失败: ${err.message}`, MAGENTA);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

// 启动 Web 服务
async function startWebServer(additionalArgs: string[]) {
  log('启动 Web 服务...', CYAN);

  try {
    const mainPath = getMainScript();
    const webArgs = ['--web', ...additionalArgs];

    const child = spawn(process.execPath, [mainPath, ...webArgs], {
      stdio: 'inherit',
      env: { ...process.env }
    });

    child.on('error', (err) => {
      log(`Web 服务启动失败: ${err.message}`, MAGENTA);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } catch (err: any) {
    log(`启动失败: ${err.message}`, MAGENTA);
    process.exit(1);
  }
}

// 启动 CLI
async function startCLI(additionalArgs: string[]) {
  log('启动命令行界面...', CYAN);

  try {
    const mainPath = getMainScript();
    const cliArgs = [...additionalArgs];

    const child = spawn(process.execPath, [mainPath, ...cliArgs], {
      stdio: 'inherit',
      env: { ...process.env }
    });

    child.on('error', (err) => {
      log(`CLI 启动失败: ${err.message}`, MAGENTA);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } catch (err: any) {
    log(`启动失败: ${err.message}`, MAGENTA);
    process.exit(1);
  }
}

// 主入口
async function main() {
  const { mode, args } = parseArgs();

  switch (mode) {
    case 'version':
      console.log(`Bolloon Agent v${VERSION}`);
      break;

    case 'help':
      printHelp();
      break;

    case 'gui':
      printBannerCli();
      await startElectron(args);
      break;

    case 'web':
      printBannerCli();
      await startWebServer(args);
      break;

    case 'cli':
      await startCLI(args);
      break;

    case 'engine':
      await handleEngineCommand(args);
      break;

    case 'passthrough':
      // 传递所有参数给主程序
      try {
        const mainPath = getMainScript();
        const child = spawn(process.execPath, [mainPath, ...args], {
          stdio: 'inherit',
          env: { ...process.env }
        });

        child.on('error', (err) => {
          log(`执行失败: ${err.message}`, MAGENTA);
          process.exit(1);
        });

        child.on('exit', (code) => {
          process.exit(code || 0);
        });
      } catch (err: any) {
        log(`执行失败: ${err.message}`, MAGENTA);
        process.exit(1);
      }
      break;

    default:
      log(`未知模式: ${mode}`, MAGENTA);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});