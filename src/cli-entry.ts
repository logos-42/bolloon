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
 *   bolloon x402 fetch <url> --private-key 0x...  # x402 钱包自动支付请求
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { printBanner } from './cli/loading-tui.js';
import { discoverEngines, delegateToEngine } from './external-engines/index.js';
import { x402CheckBalance, x402Fetch } from './agents/x402/x402Pay.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

const isWindows = process.platform === 'win32';

// ANSI 颜色 — Bolloon Web UI 配色 truecolor
function _fg(r: number, g: number, b: number): string { return `\x1b[38;2;${r};${g};${b}m`; }
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN   = _fg(0xc4, 0xd6, 0x40);  // #c4d640
const YELLOW = _fg(0xf5, 0x9e, 0x0b);  // #f59e0b
const GREEN  = _fg(0x22, 0xc5, 0x5e);  // #22c55e
const MAGENTA= _fg(0xef, 0x44, 0x44);  // #ef4444

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
  bolloon update [--now]            检查更新 / 立即更新 (bolloon update --now)
  bolloon model [name] [model]      列出 / 切换模型供应商 (如: bolloon model deepseek deepseek-v4-flash)
  bolloon read <file>               读取文档
  bolloon summarize <file>          总结文档
  bolloon improve <file> <req>      改进文档
  bolloon engine list               列出外部编码智能体
  bolloon engine run <prompt>       委派任务给智能体
  bolloon x402 fetch <url>          x402 自动支付 HTTP 请求
  bolloon x402 balance <address>    查询 x402 钱包余额

${BOLD}示例:${RESET}
  bolloon                    # 启动图形界面
  bolloon --web              # 启动 Web UI
  bolloon --cli              # 命令行模式
  bolloon model              # 查看当前模型供应商
  bolloon model minimax      # 切换到 MiniMax
  bolloon update             # 检查更新
  bolloon update --now       # 立即更新

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
  // ESM 兼容: use _require (createRequire) instead of raw require
  try {
    return _require('electron');
  } catch {
    return 'electron';
  }
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
    case 'x402':
      return { mode: 'x402', args: args.slice(1) };
    // 2026-08-06: 子命令形式 (去掉 -- 前缀)
    case 'update':
      return { mode: 'update', args: args.slice(1) };
    case 'model':
      return { mode: 'model', args: args.slice(1) };
    case 'read':
    case 'summarize':
    case 'improve':
      // 映射回旧 --flag 格式传给主程序 (保留 index.ts 现有实现)
      return { mode: 'passthrough', args: [`--${mode}`, ...args.slice(1)] };
    default:
      // 传递所有参数给主程序
      return { mode: 'passthrough', args };
  }
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function firstPositional(args: string[]): string | undefined {
  const optionsWithValue = new Set(['--private-key', '--method', '--body', '--header', '--network', '--rpc-url', '--engine', '--model', '--cwd']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (optionsWithValue.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

/** x402 子命令: fetch / balance */
async function handleX402Command(x402Args: string[]): Promise<void> {
  if (x402Args.length === 0) {
    console.log(`${BOLD}用法:${RESET}`);
    console.log('  bolloon x402 fetch <url> [options]        # 自动处理 402 Payment Required');
    console.log('  bolloon x402 balance <address> [options]  # 查询钱包余额');
    console.log('');
    console.log(`${BOLD}选项:${RESET}`);
    console.log('  --private-key <0x...>  自动支付钱包私钥，也可用 X402_PRIVATE_KEY');
    console.log('  --method <GET|POST>    HTTP 方法 (默认 GET)');
    console.log('  --body <json/text>     请求体');
    console.log('  --header <K: V>        额外 header，可重复');
    console.log('  --network <name>       base | base-sepolia | mainnet | sepolia');
    console.log('  --rpc-url <url>        自定义 RPC URL');
    console.log('  --json                 只输出 JSON 结果');
    return;
  }

  const sub = x402Args[0];
  const rest = x402Args.slice(1);

  if (sub === 'fetch') {
    const url = firstPositional(rest);
    if (!url) {
      console.error('错误: 请提供 URL');
      process.exit(1);
    }
    const headers: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--header' && i + 1 < rest.length) {
        const raw = rest[++i];
        const sep = raw.indexOf(':');
        if (sep > 0) headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
      }
    }
    const privateKey = readOption(rest, '--private-key') || process.env.X402_PRIVATE_KEY;
    const result = await x402Fetch({
      url,
      method: readOption(rest, '--method') || 'GET',
      body: readOption(rest, '--body'),
      headers,
      privateKey,
      network: readOption(rest, '--network'),
      rpcUrl: readOption(rest, '--rpc-url'),
    });
    if (hasFlag(rest, '--json')) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exit(1);
    } else if (result.success) {
      console.log(`${GREEN}✅ x402 请求完成${RESET} status=${result.status}`);
      if (result.paymentInfo?.rawHeader) console.log(`${CYAN}   payment-response: ${result.paymentInfo.rawHeader.slice(0, 160)}${RESET}`);
      console.log(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
    } else {
      console.error(`${MAGENTA}❌ x402 请求失败${RESET} status=${result.status ?? 'n/a'} ${result.error || ''}`);
      if (result.data) console.error(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
      process.exit(1);
    }
    return;
  }

  if (sub === 'balance') {
    const address = firstPositional(rest);
    if (!address) {
      console.error('错误: 请提供 EVM 地址');
      process.exit(1);
    }
    const result = await x402CheckBalance({
      address,
      network: readOption(rest, '--network'),
      rpcUrl: readOption(rest, '--rpc-url'),
    });
    if (hasFlag(rest, '--json')) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exit(1);
    } else if (result.success) {
      console.log(`${GREEN}💰 ${address}${RESET}`);
      console.log(`   balance: ${result.balance} ETH`);
      console.log(`   network: ${result.network}`);
    } else {
      console.error(`${MAGENTA}❌ 查询失败:${RESET} ${result.error}`);
      process.exit(1);
    }
    return;
  }

  console.error(`未知 x402 子命令: ${sub}`);
  process.exit(1);
}

/** update 子命令: 检查 / 执行更新 (bolloon update [--now|now] [packages]) */
async function handleUpdateCommand(updateArgs: string[]): Promise<void> {
  const { checkForUpdates, performUpdate } = await import('./utils/auto-update.js');

  // bolloon update --now / bolloon update now [packages] — 立即更新
  if (updateArgs[0] === '--now' || updateArgs[0] === 'now') {
    const packages = updateArgs.slice(1).filter(a => !a.startsWith('-'));
    console.log('🔄 正在检查并更新...');
    const result = await performUpdate(packages.length > 0 ? packages : undefined);
    if (result.success) {
      console.log(`${GREEN}✅ 更新成功${result.updatedPackages ? `: ${result.updatedPackages.join(', ')}` : ''}${RESET}`);
      if (result.updated) console.log(`${YELLOW}  请重新启动应用以使用新版本${RESET}`);
    } else {
      console.error(`${MAGENTA}❌ 更新失败: ${result.error}${RESET}`);
      process.exit(1);
    }
    return;
  }

  // 默认: 检查更新
  console.log('🔄 正在检查更新...');
  const info = await checkForUpdates();
  if (info && info.outdated) {
    console.log(`${CYAN}📦 发现更新可用:${RESET}\n`);
    console.log(`  当前版本: ${info.version}`);
    console.log(`  最新版本: ${info.latest}\n`);
    console.log(`  待更新包:`);
    for (const p of info.packages) console.log(`    - ${p.name}: ${p.current} → ${p.latest}`);
    console.log(`\n  运行 ${GREEN}bolloon update --now${RESET} 执行更新`);
  } else {
    console.log(`${GREEN}✅ 已是最新版本${RESET} (${info?.version || 'unknown'})`);
  }
}

/** model 子命令: 列出 / 切换模型供应商 (bolloon model [name] [model]) */
async function handleModelCommand(modelArgs: string[]): Promise<void> {
  const { llmConfigStore, PROVIDER_INFO } = await import('./llm/config-store.js');
  await llmConfigStore.initialize();

  // 无参: 列出所有供应商 + 当前 active
  if (modelArgs.length === 0) {
    const config = await llmConfigStore.getConfig();
    console.log(`\n${BOLD}模型供应商${RESET} (当前: ${config.activeProvider})\n`);
    console.log('─'.repeat(58));
    for (const [name, p] of Object.entries(config.providers)) {
      const info = (PROVIDER_INFO as any)[name] || {};
      const active = name === config.activeProvider ? '●' : '○';
      const keyState = p.apiKey ? '🔑' : p.requiresApiKey ? '⚠ 无 key' : '';
      const model = p.model || (info.models && info.models[0]) || '';
      console.log(`  ${active} ${name.padEnd(10)} ${String(info.name || '').padEnd(16)} ${keyState.padEnd(8)} model: ${model}`);
    }
    console.log(`\n${BOLD}用法:${RESET}`);
    console.log(`  bolloon model <name>             # 切换到该供应商`);
    console.log(`  bolloon model <name> <model>     # 切换并指定模型`);
    console.log(`  示例: bolloon model deepseek deepseek-v4-flash`);
    return;
  }

  // 切换供应商
  const name = modelArgs[0].toLowerCase();
  const config = await llmConfigStore.getConfig();
  const providers = config.providers as unknown as Record<string, { enabled: boolean; apiKey?: string; baseUrl: string; model: string; requiresApiKey?: boolean }>;
  if (!providers[name]) {
    console.error(`${MAGENTA}❌ 未知供应商: ${name}${RESET}`);
    console.error(`   可用: ${Object.keys(providers).join(', ')}`);
    process.exit(1);
  }
  const provider = providers[name];
  if (provider.requiresApiKey && !provider.apiKey) {
    console.error(`${MAGENTA}❌ ${name} 需要 API key (当前未配置)${RESET}`);
    console.error(`   配置方式: ① Web UI API 配置页  ② 环境变量 (如 DEEPSEEK_API_KEY)`);
    process.exit(1);
  }

  await llmConfigStore.setActiveProvider(name as any);
  let modelNote = '';
  if (modelArgs[1]) {
    await llmConfigStore.updateProvider(name as any, { model: modelArgs[1] });
    modelNote = `, model=${modelArgs[1]}`;
  }
  const info = (PROVIDER_INFO as any)[name] || {};
  console.log(`${GREEN}✅ 已切换到 ${name}${RESET} (${info.name || ''})${modelNote}`);
  console.log(`   当前模型: ${modelArgs[1] || provider.model || (info.models && info.models[0]) || '默认'}`);
  console.log(`   配置已持久化: ~/.bolloon/llm-config.json`);
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

    case 'x402':
      await handleX402Command(args);
      break;

    // 2026-08-06: 子命令 (bolloon update / bolloon model)
    case 'update':
      await handleUpdateCommand(args);
      break;

    case 'model':
      await handleModelCommand(args);
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
