/**
 * ToolRegistry — 工具注册表 + 别名解析器
 *
 * 2026-06-30 抽出:
 *   - 原 PiAgentSession.tools Map + resolveToolName 是 private 方法, 测试无法直接验证 alias 映射
 *   - 现在抽到独立模块, 完全可消融测试.
 *
 * 设计目标:
 *   1. claude code / 外部 harness 直接 import, 用同一份 alias 表
 *   2. 注册/反注册/查表都是纯方法, 无副作用
 *   3. 默认 alias 表跟 parse-tool-call.ts 保持一致 (read→read_file, bash→shell_exec 等)
 *   4. 自定义 alias 可注入 (业务可扩)
 *
 * 用法:
 *   import { ToolRegistry, DEFAULT_ALIASES } from './tool-registry';
 *   const reg = new ToolRegistry();
 *   reg.register({ name: 'shell_exec', description: '...', parameters: {}, execute });
 *   reg.has('bash');                  // true (alias 命中)
 *   reg.resolve('bash');              // 'shell_exec'
 *   reg.get('shell_exec')?.execute({ command: 'ls' });
 */

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, string>;
  execute: (args: Record<string, string>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** 默认 alias 表 — Claude Code 风格 → bolloon 工具名 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // file ops
  read: 'read_file',
  edit: 'edit_file',
  write: 'write_file',
  rm: 'delete_file',
  mv: 'move_file',
  cat: 'read_file',
  // shell
  bash: 'shell_exec',
  shell: 'shell_exec',
  sh: 'shell_exec',
  // test/build
  test: 'vitest_run',
  vitest: 'vitest_run',
  typecheck: 'tsc_check',
  tsc: 'tsc_check',
  // git
  log: 'git_log',
  show: 'git_show',
  diff: 'git_diff',
  commit: 'git_commit',
  push: 'git_push',
  branch: 'git_branch',
  checkout: 'git_branch',
  stash: 'git_stash',
  // task
  todo_write: 'create_task',
  todowrite: 'create_task',
  task: 'create_task',
});

export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();
  private readonly aliases: Map<string, string>;

  constructor(aliases: Record<string, string> = DEFAULT_ALIASES as Record<string, string>) {
    this.aliases = new Map();
    for (const [k, v] of Object.entries(aliases)) {
      this.aliases.set(k.toLowerCase(), v);
    }
  }

  /** 注册一个 tool (alias 字典不动) */
  register(tool: Tool): void {
    if (!tool.name) throw new Error('ToolRegistry.register: tool.name 必填');
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  /** 反注册 — 名字 + 对应 alias (如果有指向它) 全部清掉. */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    // 反向清 alias
    for (const [alias, target] of this.aliases.entries()) {
      if (target === name) this.aliases.delete(alias);
    }
    return existed;
  }

  /** 查 tool (只查主名, alias 走 resolve). */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 是否注册 (主名 + alias 命中都算). */
  has(name: string): boolean {
    if (this.tools.has(name)) return true;
    const aliased = this.aliases.get(name.toLowerCase());
    return aliased !== undefined && this.tools.has(aliased);
  }

  /** 把 LLM 输出的名字 (可能是 alias / 大小写不一致) 解析为标准主名. */
  resolve(name: string): string | null {
    if (this.tools.has(name)) return name;
    const lower = name.toLowerCase();
    const aliased = this.aliases.get(lower);
    if (aliased && this.tools.has(aliased)) return aliased;
    if (this.tools.has(lower)) return lower;
    return null;
  }

  /** 列出所有主名. 顺序按注册时间. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 当前 alias 表快照 (调试用). */
  get aliasMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.aliases.entries()) out[k] = v;
    return out;
  }

  /** 个数 */
  get size(): number {
    return this.tools.size;
  }

  /** 清空 */
  clear(): void {
    this.tools.clear();
    // alias 表保留 (除非调用方显式 clear, alias 表是稳定的)
  }

  /** 调一个 tool, 名字可能是 alias. throw if 未知. */
  async invoke(name: string, args: Record<string, string>): Promise<ToolResult> {
    const canonical = this.resolve(name);
    if (!canonical) {
      throw new Error(`ToolRegistry.invoke: 未知工具名 ${JSON.stringify(name)}`);
    }
    const tool = this.tools.get(canonical)!;
    return tool.execute(args);
  }
}
