/**
 * 工具参数校验测试 — 锁住 2026-07-12 修复:
 *   read_document / summarize_document / improve_document 必须拦 path/requirements 缺失,
 *   不能让 Node fs 抛 ERR_INVALID_ARG_TYPE: Received undefined.
 *
 * 之前这些工具直接把 args.path 传给 documentReader.read, LLM 输出空参数时炸到 UI.
 * 修复: 在 execute 入口加 if (!path) return { success: false, error: 'path 必填' }.
 */
import { describe, it, expect, vi } from 'vitest';

// mock documentReader + minimax + p2p 避免 registerBuiltinTools 的副作用依赖
vi.mock('../documents/reader.js', () => ({
  documentReader: {
    read: vi.fn(async (p: string) => {
      // 模拟真实行为: 没路径就抛, 模拟修复前的根因
      if (!p) throw new TypeError('The "path" argument must be of type string. Received undefined');
      return {
        text: 'mock content',
        metadata: { filename: p, size: 12, type: '.txt' }
      };
    })
  }
}));

vi.mock('../network/p2p.js', () => ({
  p2pNetwork: {
    getPeers: () => [],
    sendMessage: vi.fn(),
    broadcast: vi.fn()
  }
}));

vi.mock('../constraints/index.js', () => ({
  getMinimax: () => ({
    summarize: vi.fn(async () => ({ summary: 'mock summary', qualityScore: 0.8 }))
  })
}));

vi.mock('./pi-sdk-session-factory.js', () => ({
  runSelfImproveLoop: vi.fn()
}));

vi.mock('./p2p-document-tools.js', () => ({
  p2pDocumentTools: [],
  initDocumentReceiver: vi.fn()
}));

vi.mock('./shell-tool.js', () => ({
  shellExec: vi.fn()
}));

vi.mock('./shell-guard.js', () => ({
  checkWritePath: () => ({ allowed: true, reason: '' })
}));

import { registerBuiltinTools, SIDE_EFFECT_TOOLS } from '../agents/pi-sdk-tools.js';
import type { Tool } from '../agents/pi-sdk-types.js';

function makeCtx(overrides: any = {}) {
  const tools = new Map<string, Tool>();
  const ctx = {
    tools,
    cwd: '/tmp/bolloon-test',
    identity: { did: 'did:test', name: 'test' },
    persona: null,
    minimaxAvailable: true,
    setPersona: vi.fn(),
    sessionManager: { addFileContext: vi.fn(), getAllChannels: () => [] },
    constraintLayer: { getLogs: () => [] },
    _inboxMessages: [],
    ...overrides
  };
  registerBuiltinTools(ctx);
  return ctx;
}

describe('工具参数校验 (path 必填)', () => {
  it('read_document: path 缺失 → 返回 path 必填', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('read_document')!;
    expect(tool).toBeDefined();
    const r = await tool.execute({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('path 必填');
  });

  it('read_document: path 是空字符串 → 返回 path 必填', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('read_document')!;
    const r = await tool.execute({ path: '   ' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('path 必填');
  });

  it('read_document: path 有效 → 走 documentReader.read', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('read_document')!;
    const r = await tool.execute({ path: '/tmp/foo.md' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('foo.md');
  });

  it('summarize_document: path 缺失 → 返回 path 必填', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('summarize_document')!;
    const r = await tool.execute({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('path 必填');
  });

  it('summarize_document: path 有效 → 走 LLM 总结', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('summarize_document')!;
    const r = await tool.execute({ path: '/tmp/foo.md', context: '测试上下文' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('mock summary');
  });

  it('improve_document: path 缺失 → 返回 path 必填', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('improve_document')!;
    const r = await tool.execute({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('path 必填');
  });

  it('improve_document: requirements 缺失 → 返回 requirements 必填', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('improve_document')!;
    const r = await tool.execute({ path: '/tmp/foo.md' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('requirements 必填');
  });

  it('improve_document: 两个参数都有 → 走 LLM 改进', async () => {
    const ctx = makeCtx();
    const tool = ctx.tools.get('improve_document')!;
    const r = await tool.execute({ path: '/tmp/foo.md', requirements: '加粗重点' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('改进完成');
  });

  it('summarize_document: LLM 未初始化 → 返回明确错误 (不是 undefined)', async () => {
    const ctx = makeCtx({ minimaxAvailable: false });
    const tool = ctx.tools.get('summarize_document')!;
    const r = await tool.execute({ path: '/tmp/foo.md' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('MINIMAX_API_KEY');
  });
});

describe('SIDE_EFFECT_TOOLS 注册表', () => {
  it('包含 shell_exec / write_file / edit_file / git_commit', () => {
    expect(SIDE_EFFECT_TOOLS.has('shell_exec')).toBe(true);
    expect(SIDE_EFFECT_TOOLS.has('write_file')).toBe(true);
    expect(SIDE_EFFECT_TOOLS.has('edit_file')).toBe(true);
    expect(SIDE_EFFECT_TOOLS.has('git_commit')).toBe(true);
  });
});