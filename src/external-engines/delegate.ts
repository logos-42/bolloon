/**
 * external-engines/delegate.ts — 把编码任务委派给本机已安装的外部编码智能体 CLI
 *
 * 与 discovery 配合: discovery 找到 CLI 路径 + 规格, 这里真正 spawn 起来跑任务.
 *
 * 安全边界 (参照 shell-tool.ts 的护栏思路):
 *   - 只委派给"已发现且 installed"的引擎 (cliPath 来自 command -v, 不由用户输入)
 *   - prompt 作为单一 argv 传入, shell: false, 杜绝命令注入
 *   - 默认 120s 超时 (BOLLOON_ENGINE_DELEGATE_TIMEOUT_MS 可配), 超时杀进程
 *   - experiment 引擎是 API 供应商不是 CLI, 不支持委派 (提示改用 import)
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { discoverEngines, buildDelegateArgs } from './discovery.js';
import type { DelegateResult, EngineId } from './types.js';

export interface DelegateOptions {
  /** 工作目录, 默认 process.cwd() */
  cwd?: string;
  /** 委派时强制指定的模型 (如 deepseek/deepseek-v4-flash), 需要引擎支持 modelFlag */
  model?: string;
  /** 超时毫秒, 默认 120000 (env BOLLOON_ENGINE_DELEGATE_TIMEOUT_MS 可覆盖) */
  timeoutMs?: number;
}

function delegateTimeoutMs(): number {
  const env = Number(process.env.BOLLOON_ENGINE_DELEGATE_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 120_000;
}

/**
 * 把任务派发给指定引擎的 CLI 执行.
 * @param id 引擎 id: codex / claude-code / opencode / openclaw / hermes
 * @param prompt 任务描述 (作为单参数传给 CLI)
 */
export async function delegateToEngine(
  id: EngineId,
  prompt: string,
  opts: DelegateOptions = {}
): Promise<DelegateResult> {
  const trimmedId = String(id || '').trim();
  const trimmedPrompt = String(prompt || '').trim();
  if (!trimmedId) return { success: false, error: 'engine id 必填', unavailable: true };
  if (!trimmedPrompt) return { success: false, error: 'prompt 必填', unavailable: false };

  // 实验引擎是 API 供应商, 不是 CLI, 不能委派
  if (trimmedId.startsWith('experiment:')) {
    return {
      success: false,
      unavailable: true,
      error: `引擎 ${trimmedId} 是实验 API 供应商 (无 CLI), 不能委派执行. 请先用 /api/external-engines/import 把它注册为 LLM provider 后由 Bolloon 直接调用.`,
    };
  }

  // 发现引擎, 拿到 cliPath + argv 模板
  const engines = await discoverEngines();
  const engine = engines.find((e) => e.id === trimmedId);
  if (!engine) {
    return { success: false, unavailable: true, error: `未发现的引擎: ${trimmedId}` };
  }
  if (!engine.installed || !engine.cliPath) {
    return {
      success: false,
      unavailable: true,
      error: `引擎 ${trimmedId} 未安装 (CLI 不在 PATH 上), 无法委派. 可用 /api/external-engines 查看已安装列表.`,
    };
  }

  const argv = buildDelegateArgs(trimmedId, trimmedPrompt, opts.model);
  if (!argv) {
    return { success: false, unavailable: true, error: `引擎 ${trimmedId} 没有配置委派参数模板` };
  }

  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || delegateTimeoutMs();

  return new Promise<DelegateResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    // 注意: 不要用 detached:true — 实测会让 opencode 不退出 (探针: detached=true 时 90s 仍不 exit,
    //   detached=false 时 ~11s 正常 exit+close). opencode run --format json 退出干净, 无残留孙进程.
    // 监听 'exit' 而非 'close': exit 在进程退出时即触发, 更稳 (close 也正常, 两者都可用).
    const proc = spawn(engine.cliPath!, argv, {
      cwd,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      // stdin 必须 'ignore' (/dev/null): 否则 stdin 是默认管道, opencode run 会阻塞等
      // stdin EOF 导致永不退出. stdout/stderr 用 pipe 收集输出.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTree = () => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // 进程可能已退出, 忽略
      }
    };

    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killTree();
        resolve({
          success: false,
          output: stdout.slice(-8000),
          error: `委派超时 (${timeoutMs}ms), 已终止 ${trimmedId} 进程`,
          exitCode: null,
        });
      }
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 8_000_000) {
        // 超过 8MB, 截断防止内存爆炸 (仍继续收集尾部不重要)
        stdout = stdout.slice(-8_000_000);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8_000_000) stderr = stderr.slice(-8_000_000);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      killTree();
      resolve({ success: false, error: `启动 ${trimmedId} 失败: ${err.message}`, exitCode: null, unavailable: true });
    });

    // 用 'exit' 而非 'close': exit 在进程退出时即触发, 不被孙子进程持有的管道阻塞.
    // setImmediate 给最后一批 stdout data 一个 tick 的 flush 机会, 避免截断.
    proc.on('exit', (code, signal) => {
      if (settled) return;
      setImmediate(() => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        // opencode run 会留一个 headless server 孙进程继承 stdout 管道, 让 Node 的
        // 'close' 永不触发 / 事件循环不退出. destroy 掉我们这一侧的流句柄, 释放 event loop
        // (孙进程的 fd 副本在它自己进程里, 不影响 Node 退出). 结果已在 stdout/stderr 字符串里.
        try { proc.stdout?.destroy(); } catch { /* noop */ }
        try { proc.stderr?.destroy(); } catch { /* noop */ }
        killTree();
        const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
        // 2026-07-29: Sidechain transcript — 保存委派完整记录
        try {
          const sidechainDir = path.join(os.homedir(), '.bolloon', 'sidechains');
          fs.mkdir(sidechainDir, { recursive: true });
          const ts = Date.now();
          const filePath = path.join(sidechainDir, `${ts}-${trimmedId}.jsonl`);
          const entry = JSON.stringify({
            ts, engineId: trimmedId, prompt: trimmedPrompt,
            stdout: stdout.slice(0, 100_000),
            stderr: stderr.slice(0, 10_000),
            exitCode: code, duration: Date.now() - ts, model: opts.model || null,
          }) + '\n';
          // fire-and-forget, 不阻塞主流程
          fs.appendFile(filePath, entry, 'utf-8').catch(() => {});
        } catch { /* sidechain 写入失败静默 */ }
        if (code === 0) {
          resolve({ success: true, output: combined || '(无输出)', exitCode: code });
        } else if (signal) {
          resolve({ success: false, output: combined || '(无输出)', error: `${trimmedId} 被信号 ${signal} 终止`, exitCode: null });
        } else {
          resolve({ success: false, output: combined || '(无输出)', error: `${trimmedId} 退出码 ${code}`, exitCode: code });
        }
      });
    });
  });
}
