/**
 * ToolRegistry 单元测试 — 验证 2026-06-30 抽出
 *
 * 消融思路: 完全脱离 PiAgentSession / LLM / React Harness, 直接测纯注册表.
 *   claude code / 外部 harness 可以直接 import 这个验证工具注册契约.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry, DEFAULT_ALIASES, type Tool } from '../agents/tool-registry.js';

function mockTool(name: string, output = `mock-${name}-output`): Tool {
  return {
    name,
    description: `Mock tool ${name}`,
    parameters: { input: 'any string' },
    execute: async (_args) => ({ success: true, output }),
  };
}

let reg: ToolRegistry;

beforeEach(() => {
  reg = new ToolRegistry();
});

describe('ToolRegistry — 注册 / 查询', () => {
  it('register + get 主名命中', () => {
    const t = mockTool('shell_exec');
    reg.register(t);
    expect(reg.get('shell_exec')).toBe(t);
    expect(reg.has('shell_exec')).toBe(true);
  });

  it('未注册 → get undefined, has false', () => {
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('nope')).toBe(false);
  });

  it('registerAll 批量注册', () => {
    const tools = [mockTool('a'), mockTool('b'), mockTool('c')];
    reg.registerAll(tools);
    expect(reg.size).toBe(3);
    expect(reg.list()).toEqual(['a', 'b', 'c']);
  });

  it('register 空 name → 抛错', () => {
    expect(() => reg.register({ ...mockTool('x'), name: '' })).toThrow(/name 必填/);
  });

  it('unregister 移除主名 + 反向清 alias', () => {
    reg.register(mockTool('shell_exec'));
    expect(reg.has('bash')).toBe(true);  // alias 命中
    reg.unregister('shell_exec');
    expect(reg.has('shell_exec')).toBe(false);
    expect(reg.has('bash')).toBe(false);  // alias 也应失效
  });

  it('unregister 不存在 → 返回 false', () => {
    expect(reg.unregister('nope')).toBe(false);
  });
});

describe('ToolRegistry — alias 解析', () => {
  beforeEach(() => {
    reg.register(mockTool('read_file'));
    reg.register(mockTool('shell_exec'));
    reg.register(mockTool('git_log'));
    reg.register(mockTool('vitest_run'));
    reg.register(mockTool('tsc_check'));
    reg.register(mockTool('create_task'));
  });

  it('resolve 主名直接命中', () => {
    expect(reg.resolve('shell_exec')).toBe('shell_exec');
  });

  it('resolve Claude Code 别名 → 标准名 (bash→shell_exec)', () => {
    expect(reg.resolve('bash')).toBe('shell_exec');
    expect(reg.resolve('shell')).toBe('shell_exec');
    expect(reg.resolve('sh')).toBe('shell_exec');
  });

  it('resolve 大小写不敏感', () => {
    expect(reg.resolve('BASH')).toBe('shell_exec');
    expect(reg.resolve('Bash')).toBe('shell_exec');
  });

  it('resolve 已注册的子集 alias → 标准名', () => {
    // alias 必须命中已注册的 tool 才返回 (不能凭空 alias)
    // 仅测试 beforeEach 中已注册的工具 (git_stash 等未注册, 应返回 null)
    const aliasPairs: Array<[string, string]> = [
      ['read', 'read_file'],
      ['cat', 'read_file'],
      ['bash', 'shell_exec'], ['sh', 'shell_exec'],
      ['test', 'vitest_run'], ['vitest', 'vitest_run'],
      ['tsc', 'tsc_check'], ['typecheck', 'tsc_check'],
      ['log', 'git_log'],
      ['task', 'create_task'],
    ];
    for (const [alias, expected] of aliasPairs) {
      expect(reg.resolve(alias)).toBe(expected);
    }
  });

  it('resolve alias 但 alias 目标未注册 → null', () => {
    // edit 没注册 edit_file, 解析返回 null
    expect(reg.resolve('edit')).toBeNull();
    expect(reg.resolve('write')).toBeNull();
    expect(reg.resolve('commit')).toBeNull();
    expect(reg.resolve('push')).toBeNull();
  });

  it('resolve 未注册 + 未在 alias 表 → null', () => {
    expect(reg.resolve('completely-unknown-tool')).toBeNull();
  });

  it('resolve alias 但 alias 目标未注册 → null (alias 不能凭空存在)', () => {
    const emptyReg = new ToolRegistry();
    expect(emptyReg.resolve('bash')).toBeNull();
  });

  it('DEFAULT_ALIASES 不可被外部修改', () => {
    // Object.freeze 检查
    expect(() => {
      (DEFAULT_ALIASES as any).bash = 'hacked';
    }).toThrow();
  });

  it('自定义 alias 表可注入', () => {
    const custom = new ToolRegistry({ foo: 'shell_exec' });
    custom.register(mockTool('shell_exec'));
    expect(custom.resolve('foo')).toBe('shell_exec');
    // DEFAULT 不混进来
    expect(custom.resolve('bash')).toBeNull();
  });

  it('has 同时支持主名 + alias', () => {
    expect(reg.has('shell_exec')).toBe(true);
    expect(reg.has('bash')).toBe(true);
    expect(reg.has('BASH')).toBe(true);  // case insensitive
  });

  it('aliasMap 暴露当前快照', () => {
    const map = reg.aliasMap;
    expect(map.bash).toBe('shell_exec');
    expect(map.read).toBe('read_file');
  });
});

describe('ToolRegistry — invoke', () => {
  it('invoke 主名', async () => {
    reg.register(mockTool('echo', 'hello-from-echo'));
    const result = await reg.invoke('echo', {});
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello-from-echo');
  });

  it('invoke alias', async () => {
    reg.register(mockTool('shell_exec', 'ran-via-alias'));
    const result = await reg.invoke('bash', { command: 'ls' });
    expect(result.output).toBe('ran-via-alias');
  });

  it('invoke 未知名字 → throw', async () => {
    await expect(reg.invoke('nope', {})).rejects.toThrow(/未知工具名/);
  });

  it('invoke 透传 args', async () => {
    const fn = vi.fn(async (args: any) => ({ success: true, output: `got ${JSON.stringify(args)}` }));
    reg.register({ name: 'echo', description: '', parameters: {}, execute: fn });
    await reg.invoke('echo', { x: 1 });
    expect(fn).toHaveBeenCalledWith({ x: 1 });
  });
});

describe('ToolRegistry — clear + size', () => {
  it('clear 清空 tools 不动 alias', () => {
    reg.register(mockTool('shell_exec'));
    expect(reg.size).toBe(1);
    reg.clear();
    expect(reg.size).toBe(0);
    // alias 保留 (默认 alias 表与具体注册无关)
    expect(reg.aliasMap.bash).toBe('shell_exec');
  });

  it('size 随 register/unregister 变化', () => {
    expect(reg.size).toBe(0);
    reg.register(mockTool('a'));
    reg.register(mockTool('b'));
    expect(reg.size).toBe(2);
    reg.unregister('a');
    expect(reg.size).toBe(1);
  });
});
