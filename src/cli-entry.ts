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
import { runVersionCommand, runUpdateCommand, runDoctorCommand, runRuntimeCommand, UPDATE_HELP } from './cli/update-commands.js';
import { collectVersionInfo } from './utils/version-info.js';
// 2026-09-21 (P3): 统一 JSON 信封 + 命令组 (network/agent/task/wallet/payment/trade)
import { runServiceGroup, GROUPS_HELP } from './cli/commands/index.js';
// 2026-09-21 (P4): MCP 适配层 (`bolloon mcp serve` = stdio, 只调 P3 服务层)
import { runMcpCommand } from './cli/commands/mcp.js';
import { legacyJson, parseFlags, runCommand, type Code, type NextAction } from './cli/protocol-envelope.js';
import { identityCommand } from './cli/identity-command.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

/** P3 `bolloon task <子命令>` 的已知子命令 —— 其它一律当 M1 任务正文 (既有体验不动) */
const TASK_SUBCOMMANDS = new Set(['send', 'list', 'status', 'cancel', 'retry', 'result', 'inbox', 'accept', 'reject', 'run', 'complete', 'publish', 'board', 'claim', 'announce', 'trail', 'post', 'group']);


const isWindows = process.platform === 'win32';

// ANSI 颜色 — Bolloon Web UI 配色 truecolor
function _fg(r: number, g: number, b: number): string { return `\x1b[38;2;${r};${g};${b}m`; }
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN   = _fg(0xc4, 0xd6, 0x40);  // #c4d640
const YELLOW = _fg(0xf5, 0x9e, 0x0b);  // #f59e0b
const GREEN  = _fg(0x22, 0xc5, 0x5e);  // #22c55e
const MAGENTA= _fg(0xef, 0x44, 0x44);  // #ef4444

// 版本信息 — 2026-09-19: 统一走 version-info 的**唯一版本解析** (不再各读一遍 package.json)
const VERSION = collectVersionInfo({ light: true }).packageVersion;

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
  --version, -v       显示版本 (bolloon --version verbose / bolloon --version json)
  --help, -h          显示帮助信息

${BOLD}命令:${RESET}
  bolloon setup                     初始化向导 (你的称呼 + 模型供应商 + API key + 连通性测试)
  bolloon identity init             非交互建本机身份 (~/.bolloon/identity.json, 0600, 幂等; 新机器/第二实例用)
  bolloon identity show             看本机身份 (只出 DID/指纹, 绝不打印私钥)
  bolloon update [plan|status|history|now]   检查更新 / 计划 / 状态 / 历史 / 执行 (默认只检查)
  bolloon doctor                    安装入口 + 版本事实 + 更新状态自洽性诊断
  bolloon runtime [plan|install]    运行时 (Node/npm/Git/Python) 检查与安装
  bolloon model [name] [model]      列出 / 切换模型供应商 (如: bolloon model deepseek deepseek-v4-flash)
  bolloon model key <name>          配置某供应商的 API key (隐藏输入, 不回显)
  bolloon model test [name]         测试供应商连通性
  bolloon read <file>               读取文档
  bolloon summarize <file>          总结文档
  bolloon improve <file> <req>      改进文档
  bolloon engine list               列出外部编码智能体
  bolloon engine run <prompt>       委派任务给智能体
  bolloon x402 fetch <url>          x402 自动支付 HTTP 请求
  bolloon x402 balance <address>    查询 x402 钱包余额
  bolloon mcp serve                 MCP server (stdio) —— 给 MCP 客户端接本机 Agent 能力
  bolloon mcp tools                 列出 MCP 暴露的 tools/resources (只读清单)

${GROUPS_HELP}

${BOLD}示例:${RESET}
  bolloon                    # 启动图形界面
  bolloon --web              # 启动 Web UI
  bolloon --cli              # 命令行模式
  bolloon model              # 查看当前模型供应商
  bolloon update             # 检查更新 (只读, 不改任何东西)
  bolloon update plan        # 看更新计划与风险检查
  bolloon update now         # 真正执行更新
  bolloon doctor             # 我这台机器的 Bolloon 是否自洽
  bolloon network join --json         # 入网 (失败也结构化: ok:false + code + next_action)
  bolloon task --request-id <id> "…"  # 用给定幂等键跑 M1 任务 (同一 requestId 不会付两次)
${UPDATE_HELP}

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

function getElectronPath(): string | null {
  // ESM 兼容: use _require (createRequire) instead of raw require
  // 2026-08-09: electron 在 devDependencies, 全局安装不装 → require 失败返回 null
  // (上层 startElectron 收到 null 后降级为 Web 模式, 不再返回裸字符串 'electron' 导致 ENOENT)
  try {
    return _require('electron');
  } catch {
    return null;
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
      // 2026-09-19: --version 现在分三层 (普通/--verbose/--json), 参数必须往下传
      return { mode: 'version', args: args.slice(1) };
    case 'version':
      return { mode: 'version', args: args.slice(1) };
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
    // 2026-09-19: 安装入口/版本事实/更新状态 自洽性诊断
    case 'doctor':
      return { mode: 'doctor', args: args.slice(1) };
    // 2026-09-19: 运行时 (Node/npm/Git/Python) 检查与安装
    case 'runtime':
      return { mode: 'runtime', args: args.slice(1) };
    case 'model':
      return { mode: 'model', args: args.slice(1) };
    // 2026-09-18: 智能体工具执行轨迹 + 本机 P2P 连接信息 (递给名片/小工具用)
    case 'trace':
      return { mode: 'trace', args: args.slice(1) };
    case 'p2p':
      return { mode: 'p2p', args: args.slice(1) };
    // 2026-09-18: M1 唯一入口 —— 一个任务 → 一个 Skill → 一个报告卡
    case 'task':
      return { mode: 'task', args: args.slice(1) };
    // 2026-09-21: P3 命令组 (统一信封 + 全局选项; 薄包装现有服务)
    case 'network':
      return { mode: 'network', args: args.slice(1) };
    case 'agent':
      return { mode: 'agent', args: args.slice(1) };
    case 'wallet':
      return { mode: 'wallet', args: args.slice(1) };
    case 'payment':
      return { mode: 'payment', args: args.slice(1) };
    case 'trade':
      return { mode: 'trade', args: args.slice(1) };
    // 2026-09-22 (P6): 链命令组 (`bolloon chain status|escrow|timeline|index|trade`; 复用 P3/P4/P5)
    case 'chain':
      return { mode: 'chain', args: args.slice(1) };
    // 2026-09-21: P4 MCP 适配层 (`bolloon mcp serve` = stdio MCP server; 只调 P3 服务层)
    case 'mcp':
      return { mode: 'mcp', args: args.slice(1) };
    // 2026-09-13: 初始化向导 (用户身份 + 模型供应商 + API key)
    case 'setup':
    case 'init':
      return { mode: 'setup', args: args.slice(1) };
    // 2026-09-24: 非交互建本机身份 (`bolloon identity init` → ~/.bolloon/identity.json)
    case 'identity':
      return { mode: 'identity', args: args.slice(1) };
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
      // 2026-09-21 (P3): 保留既有 {success,data,status,error,paymentInfo,...}, 追加 code/message/next_action
      console.log(JSON.stringify(legacyJson(result as unknown as Record<string, unknown>, {
        code: result.success ? 'OK' : 'INTERNAL_ERROR',
        message: result.success ? `x402 请求完成 (status=${result.status})` : `x402 请求失败: ${result.error || ''}`,
        evidence: [],
        next_action: result.success ? null : 'retry_same_request',
      }), null, 2));
      if (!result.success) process.exit(1);
    } else if (hasFlag(rest, '--quiet')) {
      console.log(JSON.stringify(result));
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
      console.log(JSON.stringify(legacyJson(result as unknown as Record<string, unknown>, {
        code: result.success ? 'OK' : 'INTERNAL_ERROR',
        message: result.success ? `余额查询完成 (${result.network})` : `余额查询失败: ${result.error || ''}`,
        evidence: [address],
        next_action: result.success ? null : 'retry_same_request',
      }), null, 2));
      if (!result.success) process.exit(1);
    } else if (hasFlag(rest, '--quiet')) {
      console.log(JSON.stringify(result));
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

/** update 子命令: 2026-09-19 起统一走 src/cli/update-commands.ts 的 runUpdateCommand
 *  (旧实现只有"检查/--now"两种行为, 且各自拼一套版本信息 —— 已删除, 避免两套事实) */

/** model 子命令: 列出 / 切换模型供应商 (bolloon model [name] [model]) */
/**
 * `bolloon trace [runId] [--json] [--last N]`
 *   把 Run 的**工具执行轨迹**(真跑过什么工具、结果、耗时)导出来:
 *   无参 → 列出最近几次运行 + 每步摘要;  带 runId → 输出完整轨迹 (文本或 JSON)。
 *   文本格式与小工具/别的智能体对齐, 可直接复制粘贴交换。
 */
/**
 * `bolloon task "<任务>" --budget 0.05 [--input '<json>'] [--json]`
 * `bolloon task --resume <goalId>`
 *
 * M1 唯一入口 (leo 2026-09-18 冻结规则 ①): 用户只给任务和预算,
 * 不点名 Skill、不看内部状态。进度只报 4 个用户态, 结论在报告卡里。
 */
async function handleTaskCommand(taskArgs: string[]): Promise<void> {
  const { runTask, resumeTask } = await import('./agents/task/task-runner.js');
  const wantJson = taskArgs.includes('--json');
  const wantQuiet = taskArgs.includes('--quiet');
  const flag = (name: string): string | undefined => {
    const i = taskArgs.indexOf(name);
    return i >= 0 ? taskArgs[i + 1] : undefined;
  };
  const resumeId = flag('--resume');
  const budget = flag('--budget');
  const perPurchase = flag('--per-purchase');
  const daily = flag('--daily');
  const inputRaw = flag('--input');
  // 2026-09-21 (P3): 幂等键透传 —— 同一 requestId 重发不会产生第二笔付款 (契约层派生逻辑不变)
  const requestId = flag('--request-id');

  let input: unknown;
  if (inputRaw !== undefined) {
    try { input = JSON.parse(inputRaw); }
    catch (e: any) { console.error(`${MAGENTA}--input 不是合法 JSON: ${String(e?.message || e)}${RESET}`); process.exit(1); }
  }

  const STAGE_LABEL: Record<string, string> = { prepare: '准备中', acquire: '正在获取能力', execute: '正在执行', report: '报告' };
  const onStage = (stage: string, note: string) => {
    if (wantJson || wantQuiet) return;
    console.error(`  ${CYAN}${STAGE_LABEL[stage] || stage}${RESET} ${note}`);
  };

  if (resumeId) {
    const r = await resumeTask({ goalId: resumeId, input, allowLocalDev: true });
    const verdict = legacyTaskVerdict(r);
    const payload = {
      resumed: r.resumed, action: r.action, reason: r.reason, mustNotRepay: r.mustNotRepay, card: r.card,
      goalId: r.goalId, runId: r.runId ?? null, transactionId: r.transactionId ?? null,
    };
    if (wantQuiet) console.log(JSON.stringify(payload));
    else if (wantJson) console.log(JSON.stringify(legacyJson(payload, {
      code: verdict.code, message: verdict.message, next_action: verdict.next,
      evidence: [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[],
    }), null, 2));
    else { console.log(''); console.log(r.text); console.log(''); }
    process.exit(r.ok ? 0 : 1);
  }

  const words = taskArgs.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = taskArgs[i - 1];
    return !['--budget', '--per-purchase', '--daily', '--input', '--request-id', '--timeout'].includes(prev || '');
  });
  const task = words.join(' ').trim();
  if (!task) {
    console.log(`
${BOLD}bolloon task${RESET} — 给一个任务, 让智能体买到能力并做完它

${CYAN}bolloon task "判断这款厨房用品是否适合进入日本市场" --budget 0.05${RESET}
${CYAN}bolloon task --resume <goalId>${RESET}

选项:
  --budget <USDC>        这笔任务最多花多少 (M1 硬上限 0.05; 不能中途扩大)
  --per-purchase <USDC>  单次购买上限 (M1 硬上限 0.02)
  --daily <USDC>         当日预算 (M1 硬上限 0.10)
  --input '<json>'       显式给技能输入 (跳过自动推导)
  --request-id <id>      指定幂等键 (同一 requestId 重发不会产生第二笔付款)
  --json                 机器可读输出 (+ code/next_action/evidence; 失败也结构化)
`);
    return;
  }

  const r = await runTask({ task, budget, perPurchase, daily, input, requestId, allowLocalDev: true, onStage });
  const verdict = legacyTaskVerdict(r);
  if (wantQuiet) {
    console.log(JSON.stringify({ ok: r.ok, goalId: r.goalId, runId: r.runId, transactionId: r.transactionId, card: r.card, payment: r.payment }));
  } else if (wantJson) {
    console.log(JSON.stringify(legacyJson({
      ok: r.ok, status: r.card.status, conclusion: r.card.conclusion, card: r.card,
      goalId: r.goalId, runId: r.runId, transactionId: r.transactionId,
      advisor: r.advisor, payment: r.payment, outputIssues: r.outputIssues,
      budget: { taskBudget: r.budget.taskBudget, perPurchase: r.budget.perPurchase, daily: r.budget.daily, clamped: r.budget.clamped },
      stages: r.stages,
    }, {
      code: verdict.code, message: verdict.message, next_action: verdict.next,
      evidence: [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[],
    }), null, 2));
  } else {
    console.log('');
    console.log(r.text);
    console.log('');
  }
  // 一次性命令: 显式收尾 (DIAP/HTTP 句柄不该吊住进程)
  process.exit(r.ok ? 0 : 1);
}

/**
 * 老 M1 命令 (`bolloon task`) 的 §3 码映射 (P1 §3 + §5.1 红线):
 * local-dev 最高到 `delivered` → 一律 `TASK_COMPLETED` + `verify_result`, **绝不** TASK_VERIFIED。
 */
function legacyTaskVerdict(r: { ok: boolean; payment?: any; card?: any }): { code: Code; message: string; next: NextAction } {
  const chain = r.payment?.chainSettled === true || r.card?.payment?.chainSettled === true;
  if (r.ok) {
    return chain
      ? { code: 'TASK_VERIFIED', message: 'Task verified', next: null }
      : { code: 'TASK_COMPLETED', message: 'Task delivered (local-dev: 链上未结算, 不算成功)', next: 'verify_result' };
  }
  return r.card?.hardGate === 'bought_not_executed'
    ? { code: 'DELIVERY_FAILED', message: '已付款但没有交付 → 绝不重付, 交人处理', next: 'needs_human' }
    : { code: 'RESULT_UNVERIFIED', message: '任务没走完/未过验真门', next: 'needs_human' };
}

async function handleTraceCommand(traceArgs: string[]): Promise<void> {
  const { listRuns, readRun } = await import('./agents/run-store.js');
  const { runToTraceText, runToTraceJson, summarizeTrace } = await import('./agents/trace-export.js');
  const wantJson = traceArgs.includes('--json');
  const wantQuiet = traceArgs.includes('--quiet');
  const lastIdx = traceArgs.indexOf('--last');
  const last = lastIdx >= 0 ? Number(traceArgs[lastIdx + 1]) : undefined;
  const runId = traceArgs.find((a) => !a.startsWith('--') && a !== String(last));

  if (!runId) {
    const runs = await listRuns({ limit: 20 });
    const payloads = runs.map((r: any) => runToTraceJson(r));
    if (wantQuiet) { console.log(JSON.stringify(payloads)); return; }
    if (wantJson) {
      // 2026-09-21 (P3): 列表形式也走统一信封 (此前是裸数组; `data` 里仍是同样的 payload 数组)
      console.log(JSON.stringify({ ok: true, code: 'OK', message: `最近 ${runs.length} 次运行`, data: payloads, evidence: payloads.map((p: any) => p.runId).filter(Boolean), next_action: null }, null, 2));
      return;
    }
    console.log(`\n${BOLD}最近 ${runs.length} 次运行的执行轨迹${RESET}\n`);
    if (!runs.length) {
      console.log('  还没有运行记录 (落盘在 ~/.bolloon/runs/)');
      console.log(`  ${CYAN}先让智能体干点活: bolloon --prompt "列出当前目录文件"${RESET}\n`);
      return;
    }
    console.log('─'.repeat(72));
    for (const r of runs) {
      console.log(`  ${r.runId}  [${r.status}]  ${summarizeTrace(r)}`);
    }
    console.log('─'.repeat(72));
    console.log(`  ${CYAN}bolloon trace <runId>            看完整轨迹 (文本, 可复制交换)`);
    console.log(`  bolloon trace <runId> --json    机器可读${RESET}\n`);
    return;
  }

  const run = await readRun(runId);
  if (!run) {
    console.error(`${MAGENTA}没有这个运行: ${runId}${RESET}`);
    if (wantJson) console.log(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: `没有这个运行: ${runId}`, data: { runId }, evidence: [], next_action: 'retry_same_request' }, null, 2));
    process.exitCode = 1;
    return;
  }
  const j = runToTraceJson(run);
  if (wantQuiet) console.log(JSON.stringify(j));
  else if (wantJson) console.log(JSON.stringify(legacyJson(j as unknown as Record<string, unknown>, { code: 'OK', message: `运行 ${runId} 轨迹`, evidence: [runId], next_action: null }), null, 2));
  else console.log(runToTraceText(run, { limit: last }));
  if (!wantJson && !wantQuiet) {
    console.error(`\n${CYAN}(${j.counts.total} 步 · ✓${j.counts.ok} / ✗${j.counts.fail} · ${j.counts.totalMs}ms · 状态 ${j.status})${RESET}`);
  }
}

/**
 * `bolloon p2p [--json]`
 *   打印本机 P2P 连接信息 (peerId + 可拨入 multiaddr), 直接可抄进名片/小工具/递给对方智能体。
 *   只报真实拿到的: 节点没跑就说明原因与下一步, 不编造 peerId。
 */
async function handleP2pCommand(p2pArgs: string[]): Promise<void> {
  const { getLocalP2pInfo, formatP2pInfoText, formatP2pInfoJson } = await import('./agents/p2p-info.js');
  const info = await getLocalP2pInfo();
  if (p2pArgs.includes('--quiet')) {
    console.log(JSON.stringify(JSON.parse(formatP2pInfoJson(info))));
  } else if (p2pArgs.includes('--json')) {
    // 2026-09-21 (P3): 保留 bolloon-p2p-info/1 的全部既有字段, 追加 §2 的 code/message/evidence/next_action
    const payload = JSON.parse(formatP2pInfoJson(info)) as Record<string, unknown>;
    console.log(JSON.stringify(legacyJson(payload, {
      code: 'OK',
      message: info.ok ? `本机 P2P 信息 (peerId=${String(info.peerId).slice(0, 16)}…)` : '还没有本机 peerId',
      evidence: info.peerId ? [String(info.peerId)] : [],
      next_action: info.ok ? null : 'rejoin_network',
    }), null, 2));
  } else console.log(formatP2pInfoText(info));
  // 一次性信息命令必须自己收尾: 读运行中节点会 import network/p2p (libp2p),
  // 那是常驻模块, 句柄不会自己关 → 不显式退出会"输出完了还挂着"。
  process.exit(info.ok ? 0 : 1);
}

async function handleModelCommand(modelArgs: string[]): Promise<void> {
  const { llmConfigStore } = await import('./llm/config-store.js');
  const { buildProviderSummaries, formatProviderLine } = await import('./llm/model-catalog.js');
  const { effectiveModelConfig, formatEffectiveModel } = await import('./llm/model-selection.js');
  await llmConfigStore.initialize();

  // 无参: 列出所有供应商 + 当前**真实生效**的那一份 + 指引分步选择器
  if (modelArgs.length === 0) {
    const eff = await effectiveModelConfig({}).catch(() => null);
    const summaries = await buildProviderSummaries({});
    console.log(`\n${BOLD}模型供应商${RESET} (当前生效: ${eff ? `${eff.provider}/${eff.model}` : '读不出来'})\n`);
    if (eff) console.log(`  ${formatEffectiveModel(eff)}`);
    console.log('─'.repeat(58));
    for (const s of [...summaries.filter((x) => x.configured), ...summaries.filter((x) => !x.configured)]) {
      console.log(`  ${formatProviderLine(s)}`);
    }
    console.log(`\n${BOLD}用法:${RESET}`);
    console.log(`  bolloon model pick                # 分步选择 (供应商→凭证→模型→参数→作用域→测试→确认)`);
    console.log(`  bolloon model <name>             # 切换到该供应商`);
    console.log(`  bolloon model <name> <model>     # 切换并指定模型`);
    console.log(`  示例: bolloon model deepseek deepseek-v4-flash`);
    return;
  }

  // 有参: 统一交给 setup-wizard 的 runModelCommand
  //   (pick 分步选择 / 切换 / <provider> <model> / key <provider> / test / status 一套语义,
  //    与 CLI 会话内 /model 完全一致 —— 写配置与重建运行时的逻辑只有 selectModel 一处)
  const { runModelCommand, askHiddenLine, askLine } = await import('./cli/setup-wizard.js');
  const out = await runModelCommand(modelArgs.join(' '), {
    // 正常终端里可以安全收 key (隐藏输入, 不回显)
    askHidden: (q: string) => askHiddenLine(q),
    // 分步选择器的文本输入 (搜索模型 / 手工 temperature)
    ask: (q: string, opts?: { default?: string }) => askLine(q, opts),
  });
  for (const line of String(out).split('\n')) console.log(line);
}

/** `bolloon setup` — 首次运行初始化向导 (用户身份 + 模型供应商 + API key + 连通性测试) */
async function handleSetupCommand(setupArgs: string[]): Promise<void> {
  const { runSetupWizard } = await import('./cli/setup-wizard.js');
  const val = (name: string) => {
    const i = setupArgs.indexOf(name);
    return i >= 0 && i + 1 < setupArgs.length ? setupArgs[i + 1] : undefined;
  };
  if (setupArgs.includes('repair-runtime') || setupArgs.includes('--repair-runtime')) {
    // Phase 7: 补装缺失运行时 (与 bolloon runtime install yes 同一实现)
    console.log(`${BOLD}setup repair-runtime${RESET} — 检查并补装 Node/npm/Git/Python (不偷偷 sudo)`);
    process.exit(await runRuntimeCommand(['install', 'yes']));
  }
  if (setupArgs.includes('--help') || setupArgs.includes('-h')) {
    console.log(`${BOLD}bolloon setup${RESET} — 初始化 Bolloon (用户身份 + 模型供应商 + API key)`);
    console.log('');
    console.log('  无参数            交互式向导 (推荐)');
    console.log('  --provider <名>   指定供应商 (deepseek / minimax / openai / anthropic / ...)');
    console.log('  --api-key <key>   直接给 key (脚本用; 交互模式会隐藏输入)');
    console.log('  --model <名>      指定模型');
    console.log('  --name <称呼>     你的称呼 (写入 ~/.bolloon/identity/user.json)');
    console.log('  --no-test         跳过连通性测试');
    console.log('  repair-runtime    检查并补装缺失运行时 (Node/npm/Git/Python)');
    return;
  }
  const apiKey = val('--api-key');
  const needsInteractive = !apiKey;
  const r = await runSetupWizard({
    interactive: needsInteractive,
    provider: val('--provider'),
    apiKey,
    model: val('--model'),
    name: val('--name'),
    skipTest: setupArgs.includes('--no-test'),
  });
  if (!r.ok) {
    console.error(`${MAGENTA}✗ 初始化失败: ${r.error}${RESET}`);
    process.exit(1);
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

  // 2026-08-09: electron 是 devDependency, 全局安装不包含 → 降级为 Web 模式
  // (浏览器打开 Web UI, 功能等价, 避免 spawn electron ENOENT 直接退出)
  if (!electronPath) {
    log('未检测到 Electron 桌面运行时 (全局安装不含 devDependencies)', YELLOW);
    log('自动降级为 Web 模式 — 浏览器打开 Web UI...', CYAN);
    await startWebServer(additionalArgs);
    return;
  }

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
      // 2026-09-19: 三层版本输出 (普通/--verbose/--json) 全走同一个 VersionInfo
      process.exit(await runVersionCommand(args));
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
      process.exit(await runUpdateCommand(args));
      break;

    case 'doctor':
      process.exit(await runDoctorCommand(args));
      break;

    // 2026-09-19: 运行时检查/安装 (与 install.sh / postinstall / doctor 同一实现)
    case 'runtime':
      process.exit(await runRuntimeCommand(args));
      break;

    case 'model':
      await handleModelCommand(args);
      break;

    // 2026-09-18: 工具执行轨迹 / P2P 连接信息
    case 'trace':
      await handleTraceCommand(args);
      break;

    case 'p2p':
      await handleP2pCommand(args);
      break;

    // 2026-09-18: M1 任务闭环 (bolloon task "<任务>" --budget 0.05 / --resume <goalId>)
    case 'task':
      // 2026-09-21 (P3): 已知子命令 → 命令组 (统一信封); 其它一律当 M1 任务正文 (既有体验不动)
      if (args[0] && TASK_SUBCOMMANDS.has(args[0])) process.exit(await runServiceGroup('task', args));
      await handleTaskCommand(args);
      break;

    // 2026-09-21 (P3): 命令组 (network/agent/wallet/payment/trade) —— 统一信封 + 薄包装现有服务
    // 2026-09-22 (P6): 追加 chain (链上能力: 状态/escrow/时间线/索引/交易)
    case 'network':
    case 'agent':
    case 'wallet':
    case 'payment':
    case 'trade':
    case 'chain':
      process.exit(await runServiceGroup(mode, args));
      break;

    // 2026-09-21 (P4): MCP 适配层 (`bolloon mcp serve` = stdio MCP server; tools/resources 只调 P3 服务层)
    case 'mcp':
      process.exit(await runMcpCommand(args));
      break;

    // 2026-09-13: bolloon setup — 首次运行初始化向导
    case 'setup':
      await handleSetupCommand(args);
      break;

    // 2026-09-24: bolloon identity — 非交互建/看本机身份 (新机器/第二实例用; 幂等, 不打印私钥)
    case 'identity':
      process.exit(await runCommand(parseFlags(args), identityCommand));
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
