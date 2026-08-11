/**
 * verify-recipe.ts — 项目验证配方 (借鉴 Hermes agent/verify/recipes.py:
 *   从项目自己的 package.json scripts 提取验证命令, 依序执行 build→test)
 *
 * 用途: agent 完成修改后跑 verify_project 工具 → 完成契约 (B7) 要求的证据落地 —
 *   "宣布完成前展示具体证据 (命令输出/测试结果)" 有了工具支撑.
 * 纯函数 + runner 分离, 可单测.
 */

import { spawn } from 'child_process';

export interface VerifyCommand {
  /** 步骤名 (test/build/typecheck/lint/check) */
  name: string;
  /** 执行的 shell 命令 (在项目根) */
  command: string;
}

export interface VerifyStepResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** 输出尾部 (cap 2000 字符) */
  outputTail: string;
  timedOut: boolean;
}

export interface VerifyRecipeResult {
  steps: VerifyStepResult[];
  allPassed: boolean;
}

/**
 * 从 package.json scripts 提取验证命令 (Hermes _detect_node_recipe 逻辑):
 *   build 阶段: build, typecheck (存在才加, 按序)
 *   test 阶段:  test, check, lint (存在才加, 按序)
 * runner: npm run <script> (pnpm/bun/yarn 时对应前缀)
 */
export function extractVerifyCommands(
  scripts: Record<string, string> | undefined,
  packageManager?: string
): VerifyCommand[] {
  if (!scripts || typeof scripts !== 'object') return [];
  const runner = (entry: string): string => {
    if (packageManager === 'pnpm') return `pnpm ${entry}`;
    if (packageManager === 'bun') return `bun run ${entry}`;
    if (packageManager === 'yarn') return `yarn ${entry}`;
    return `npm run ${entry}`;
  };
  const out: VerifyCommand[] = [];
  for (const name of ['build', 'typecheck', 'test', 'check', 'lint']) {
    if (typeof scripts[name] === 'string') {
      out.push({ name, command: runner(name) });
    }
  }
  return out;
}

/** 从 lockfile 检测包管理器 (Hermes detect_package_manager) */
export function detectPackageManager(files: string[]): string | undefined {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json')) return 'npm';
  return undefined;
}

/** 依序执行验证命令; 任一步失败不中断 (收集全量结果), 全部 exit 0 才算通过 */
export async function runVerifyCommands(
  opts: { cwd: string; commands: VerifyCommand[]; stepTimeoutMs?: number }
): Promise<VerifyRecipeResult> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 5 * 60 * 1000;
  const steps: VerifyStepResult[] = [];
  for (const cmd of opts.commands) {
    const t0 = Date.now();
    const result = await new Promise<Omit<VerifyStepResult, 'name' | 'command'>>((resolve) => {
      const child = spawn(cmd.command, { cwd: opts.cwd, shell: true, env: process.env });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, stepTimeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
        if (output.length > 20_000) output = output.slice(-20_000);
      });
      child.stderr?.on('data', (d: Buffer) => {
        output += d.toString();
        if (output.length > 20_000) output = output.slice(-20_000);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, durationMs: Date.now() - t0, outputTail: output.slice(-2000), timedOut });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, durationMs: Date.now() - t0, outputTail: `spawn 失败: ${err.message}`, timedOut });
      });
    });
    steps.push({ name: cmd.name, command: cmd.command, ...result });
  }
  return { steps, allPassed: steps.every((s) => s.exitCode === 0 && !s.timedOut) };
}
