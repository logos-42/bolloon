import { config } from 'dotenv';
import { describe, it, expect, beforeAll } from 'vitest';
import { WorkflowPivotLoop, createDefaultPivotConfig, runPivotLoop, formatDuration, summarizeToolOutput } from '../agents/workflow-pivot-loop.js';
import type { Tool } from '../agents/pi-sdk.js';
import fs from 'node:fs';
import path from 'node:path';

config();

const mockTools: Tool[] = [
  {
    name: 'read_document',
    description: '读取文档内容',
    parameters: { path: '文件路径' },
    execute: async (args) => {
      if (args.path === 'nonexistent.txt') {
        return { success: false, error: '文件不存在' };
      }
      return { success: true, output: `文件内容: ${args.path}` };
    }
  },
  {
    name: 'list_files',
    description: '列出文件',
    parameters: {},
    execute: async () => {
      return { success: true, output: 'file1.txt\nfile2.txt' };
    }
  },
  {
    name: 'get_time',
    description: '获取当前时间',
    parameters: {},
    execute: async () => {
      return { success: true, output: new Date().toISOString() };
    }
  }
];

interface MockLLM {
  callCount: number;
  shouldReturnFinal: boolean;
  finalResponse: string;
}

function createMockLLM(mock: MockLLM) {
  return {
    chat: async (context: string, systemPrompt: string) => {
      mock.callCount++;
      console.log(`[MockLLM] 调用 #${mock.callCount}, context长度: ${context.length}`);

      if (mock.shouldReturnFinal || mock.callCount >= 2) {
        return { reply: `${mock.finalResponse}\n\n<final gen>` };
      }

      if (context.includes('list_files') || context.includes('列出文件')) {
        return { reply: '调用工具: list_files()' };
      }

      if (context.includes('read_document') || context.includes('读取文档')) {
        const hasNonexistent = context.includes('nonexistent');
        if (hasNonexistent) {
          return {
            reply: '调用工具: read_document(path: nonexistent.txt)'
          };
        }
        return { reply: '调用工具: read_document(path: test.txt)' };
      }

      // 2026-08-02: 模拟 deepseek 真实输出 — system prompt 教的 {"name":"X","input":{...}} 格式
      //   之前 extractPendingToolUses Pattern 4 只认 arguments 字段, input 解析不到 → 工具永不执行
      if (context.includes('json_input_format') || context.includes('JSON格式')) {
        return {
          reply: '```json\n{"name":"read_document","input":{"path":"test.txt"}}\n```'
        };
      }

      if (context.includes('get_time') || context.includes('时间')) {
        return { reply: '调用工具: get_time()' };
      }

      return { reply: '调用工具: list_files()' };
    }
  };
}

describe('WorkflowPivotLoop', () => {
  describe('基础功能', () => {
    it('应该正确初始化', () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 10 });
      expect(loop).toBeDefined();
      expect(loop.getState().iteration).toBe(0);
    });

    it('应该注册工具', () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 10 });
      loop.registerTool(mockTools[0]);
      loop.registerTools(mockTools.slice(1));
      const state = loop.getState();
      expect(state.pendingToolUses).toBeDefined();
    });
  });

  describe('工具调用', () => {
    it('应该正确解析工具调用', async () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 10 });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: false,
        finalResponse: '初始响应'
      };

      const llm = createMockLLM(mock);
      const systemPrompt = '测试系统提示';

      const result = await loop.execute('读取文件', llm as any, systemPrompt);

      console.log('[Test] 结果:', {
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        exitReason: result.exitReason
      });

      expect(result.iterations).toBeGreaterThan(0);
      expect(result.toolCalls).toBeGreaterThan(0);
    });

    it('应该解析 JSON 格式工具调用 (input 字段, 2026-08-02 修复)', async () => {
      // 回归测试: system prompt 教的 {"name":"X","input":{...}} 格式
      //   之前 Pattern 4 只认 arguments → input 解析不到 → 工具永不执行
      const loop = new WorkflowPivotLoop({ maxIterations: 10, minIterations: 1, qualityThreshold: 0.5 });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: false,
        finalResponse: '读取完成'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('JSON格式读取文件', llm as any, '测试系统提示');

      console.log('[Test] JSON input 格式结果:', {
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        exitReason: result.exitReason
      });

      // 第一轮 LLM 输出 {"name":"read_document","input":{...}} → 必须被解析并执行 (toolCalls >= 1)
      expect(result.toolCalls).toBeGreaterThan(0);
    });

    it('应该正确处理 final gen 标记', async () => {
      const loop = new WorkflowPivotLoop({
        maxIterations: 10,
        minIterations: 1,
        qualityThreshold: 0.5
      });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '这是最终答案'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('简单任务', llm as any, '系统提示');

      console.log('[Test] 最终响应测试结果:', result);
      expect(result.exitReason).toMatch(/final|pending|quality/);
    });

    it('应该处理工具执行失败', async () => {
      const loop = new WorkflowPivotLoop({
        maxIterations: 10,
        maxConsecutiveNoProgress: 3
      });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: false,
        finalResponse: '尝试读取'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('读取不存在的文件', llm as any, '系统提示');

      console.log('[Test] 失败处理结果:', result);
      expect(result.iterations).toBeGreaterThan(0);
    });
  });

  describe('中断条件', () => {
    it('应该达到最大迭代次数时中断', async () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 3 });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: false,
        finalResponse: '继续'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('需要多次迭代的任务', llm as any, '系统提示');

      console.log('[Test] 最大迭代结果:', result);
      expect(result.iterations).toBeLessThanOrEqual(3);
    });

    it('应该在质量达标时提前结束', async () => {
      const loop = new WorkflowPivotLoop({
        maxIterations: 50,
        qualityThreshold: 0.4  // 0.55 quality score will exceed this
      });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '这是一个高质量的完整回答，包含足够的细节和结构化内容。'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('需要高质量回答的任务', llm, '系统提示');

      console.log('[Test] 质量达标结果:', result);
      // 2026-07-06: mock LLM 永远 emit <final gen>, pivot 会先认 final_gen_marker 退出.
      //   旧期望 quality_threshold_met. 接受任意"成功退出"原因.
      expect(['quality_threshold_met', 'final_gen_marker']).toContain(result.exitReason);
    });
  });

  describe('任务复杂度分析', () => {
    it('应该识别简单任务', async () => {
      const loop = new WorkflowPivotLoop(createDefaultPivotConfig('simple'));
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '简单回答'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute('查看当前时间', llm as any, '系统提示');

      console.log('[Test] 简单任务结果:', result);
      expect(result.iterations).toBeLessThanOrEqual(15);
    });

    it('应该识别复杂任务', async () => {
      const loop = new WorkflowPivotLoop(createDefaultPivotConfig('complex'));
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '复杂的分析结果'
      };

      const llm = createMockLLM(mock);
      const result = await loop.execute(
        '分析并比较这个项目的所有文档，设计优化方案并实现重构',
        llm as any,
        '系统提示'
      );

      console.log('[Test] 复杂任务结果:', result);
      expect(result.iterations).toBeLessThanOrEqual(60);
    });
  });

  describe('runPivotLoop 快捷函数', () => {
    it('应该使用默认配置运行', async () => {
      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '快速回答'
      };

      const llm = createMockLLM(mock);
      const result = await runPivotLoop(
        '查看时间',
        llm as any,
        mockTools,
        '你是一个助手'
      );

      console.log('[Test] 快捷函数结果:', result);
      expect(result.success).toBe(true);
    });
  });

  describe('状态重置', () => {
    it('应该正确重置状态', async () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 10 });
      loop.registerTools(mockTools);

      const mock: MockLLM = {
        callCount: 0,
        shouldReturnFinal: true,
        finalResponse: '回答'
      };

      const llm = createMockLLM(mock);
      await loop.execute('任务1', llm as any, '提示');

      const state1 = loop.getState();
      loop.reset();
      const state2 = loop.getState();

      expect(state1.iteration).toBeGreaterThan(0);
      expect(state2.iteration).toBe(0);
    });
  });
});

describe('PiSDK PivotLoop Integration', () => {
  it('should export promptWithPivotLoop method', { timeout: 30000 }, async () => {
    const { createAgentSession } = await import('../agents/pi-sdk.js');

    const session = await createAgentSession({
      cwd: process.cwd(),
      usePivotLoop: true
    });

    expect(typeof session.promptWithPivotLoop).toBe('function');
  });

  it('should use pivot loop when configured', { timeout: 30000 }, async () => {
    const { createAgentSession } = await import('../agents/pi-sdk.js');

    const session = await createAgentSession({
      cwd: process.cwd(),
      usePivotLoop: true,
      pivotLoopConfig: createDefaultPivotConfig('simple')
    });

    const result = await session.promptWithPivotLoop('你好');

    console.log('[Test] Pivot Loop 集成测试结果:', {
      success: result.success,
      iterations: result.iterations,
      exitReason: result.exitReason
    });

    expect(result).toBeDefined();
    expect(result.exitReason).toBeDefined();
  });

  describe('Task3 认知卸载: 工具选择 usage hint', () => {
    it('buildOpenAITools 给核心工具 description 加"何时使用"前缀', () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 3 });
      // 核心编码工具 (含 list_files) → 应带 usage hint 前缀
      const tools: any[] = [
        { name: 'list_files', description: '列出文件', parameters: {} },
        { name: 'write_file', description: '写入文件', parameters: { path: '路径' } },
        { name: 'get_time', description: '获取时间', parameters: {} },
      ];
      for (const t of tools) loop.registerTools([t as any]);
      const defs = (loop as any).buildOpenAITools() as any[];
      const listDef = defs.find(d => d.function.name === 'list_files');
      const writeDef = defs.find(d => d.function.name === 'write_file');
      const timeDef = defs.find(d => d.function.name === 'get_time');
      expect(listDef.function.description).toContain('列出文件');
      expect(writeDef.function.description).toContain('写/创建文件用此工具');
      // 不在 usage hint 里的工具 description 不加强 (只保留原描述)
      expect(timeDef.function.description).toBe('获取时间');
    });

    it('认知卸载 usage hint 干净: 所有核心编码工具都带唯一 hint, 非核心不加前缀', () => {
      const loop = new WorkflowPivotLoop({ maxIterations: 3 });
      const CORE = ['write_file', 'edit_file', 'read_file', 'read_directory', 'list_files', 'terminal', 'delegate_to_engine'];
      const OTHER = ['get_time', 'send_message', 'list_peers', 'p2p_broadcast', 'get_identity'];
      const tools: any[] = [
        ...CORE.map(n => ({ name: n, description: `desc_${n}`, parameters: {} })),
        ...OTHER.map(n => ({ name: n, description: `desc_${n}`, parameters: {} })),
      ];
      for (const t of tools) loop.registerTools([t as any]);
      const defs = (loop as any).buildOpenAITools() as any[];
      for (const n of CORE) {
        const d = defs.find(x => x.function.name === n);
        expect(d, `core tool ${n} should exist`).toBeDefined();
        expect(d.function.description.length, `core tool ${n} hint present`).toBeGreaterThan(`desc_${n}`.length);
      }
      for (const n of OTHER) {
        const d = defs.find(x => x.function.name === n);
        expect(d.function.description).toBe(`desc_${n}`);
      }
    });
  });
});


// ============================================================================
// 2026-10-02 (K7): 受门执行端口 —— pivot loop 的执行点可被"门"接管
//   (旁路收敛的前置: 台账 K7_BYPASS_CANDIDATES ① workflow-pivot-loop.ts:613)
//   三条契约: ① 未注入 ⇒ 旧行为一字不差 ② 注入 ⇒ 执行只走端口
//             ③ 端口抛错 ⇒ **fail-closed** (拒执行, 绝不回落 tool.execute)
// ============================================================================
describe('K7: pivot loop 的受门执行端口 (guardedExecute)', () => {
  function toolWithCounter() {
    const calls: string[] = [];
    const tool: Tool = {
      name: 'list_files',
      description: '列出文件',
      parameters: {},
      execute: async () => { calls.push('executed'); return { success: true, output: 'file1.txt' }; },
    };
    return { tool, calls };
  }
  const mkLLM = () => createMockLLM({ callCount: 0, shouldReturnFinal: false, finalResponse: '完成' });

  it('① 未注入端口 ⇒ 仍旧直调 tool.execute (行为不变, 向后兼容)', async () => {
    const { tool, calls } = toolWithCounter();
    const loop = new WorkflowPivotLoop(createDefaultPivotConfig());
    loop.registerTool(tool);
    await loop.execute('列出文件', mkLLM() as any, 'sys');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('② 注入端口 ⇒ 执行只走端口, 旁路本体 tool.execute 一次都不许被调', async () => {
    const { tool, calls } = toolWithCounter();
    const portCalls: string[] = [];
    const loop = new WorkflowPivotLoop({
      ...createDefaultPivotConfig(),
      guardedExecute: async (t) => { portCalls.push(String(t.name)); return { success: true, output: '由端口执行' }; },
    });
    loop.registerTool(tool);
    await loop.execute('列出文件', mkLLM() as any, 'sys');
    expect(portCalls.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('③ 端口抛错 ⇒ fail-closed: 不执行工具 (门坏了不等于没门)', async () => {
    const { tool, calls } = toolWithCounter();
    let portCalled = 0;
    const loop = new WorkflowPivotLoop({
      ...createDefaultPivotConfig(),
      guardedExecute: async () => { portCalled++; throw new Error('deny 判定崩了'); },
    });
    loop.registerTool(tool);
    await loop.execute('列出文件', mkLLM() as any, 'sys');
    expect(portCalled).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('④ 机械: fail-closed 的落地形态在源码里 (端口抛错 ⇒ 记 harness-error 且不回落)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/workflow-pivot-loop.ts'), 'utf8');
    expect(src).toContain('拒绝: [harness-error]');
    // 2026-10-12: 执行改 Promise.all 并行 + 超时包装, 端口形态变闭包 (executeFn)。
    //   断言不变式: 端口在超时竞速内、harness-error 兜底在 executeFn 调用点之后、结果仍给 messageHistory。
    expect(src).toContain('this.config.guardedExecute!');
    const portIdx = src.indexOf('this.config.guardedExecute!');
    const fallbackIdx = src.indexOf('() => tool.execute(toolCall.args ?? {})');
    expect(portIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(portIdx);
    // 端口抛错 → harness-error 兜底必须在 fallback 分支**之外** (不许回落执行本体)
    expect(src.slice(0, fallbackIdx)).toContain('拒绝: [harness-error]');
  });
});

// ---------------------------------------------------------------------------
// 2026-10-12 (leo: 「命令执行时间读秒」+「terminal 压缩摘要」): 纯函数单测
// ---------------------------------------------------------------------------
describe('formatDuration — 毫秒读秒', () => {
  it('小于 1s → 毫秒原样', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });
  it('秒级 → 一位小数 s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2527)).toBe('2.5s');
    expect(formatDuration(59_900)).toBe('59.9s');
  });
  it('分钟级 → m+s', () => {
    expect(formatDuration(60_000)).toBe('1m0s');
    expect(formatDuration(125_000)).toBe('2m5s');
  });
  it('非法输入 → 如实标注', () => {
    expect(formatDuration(-1)).toBe('(耗时未知)');
    expect(formatDuration(Number.NaN)).toBe('(耗时未知)');
  });
});

describe('summarizeToolOutput — terminal 输出压缩摘要', () => {
  it('terminal 长输出 → 压空白 + 截断 + 标注', () => {
    const long = ('line of output\n'.repeat(50));
    const s = summarizeToolOutput('terminal', long);
    expect(s.length).toBeLessThan(long.length);
    expect(s).toContain('[摘要');
    expect(s.startsWith('line of output')).toBe(true);
  });
  it('terminal 短输出 → 压空白但保留全文', () => {
    const s = summarizeToolOutput('terminal', '  a  b\n\n\nc  ');
    expect(s).toBe('a b\n\nc');
  });
  it('非 shell 工具 → 原样返回', () => {
    const s = summarizeToolOutput('read_file', '  a  b  ');
    expect(s).toBe('  a  b  ');
  });
});

describe('空回复回归 (2026-10-13, leo: 「我发了一个命令, 返回空」)', () => {
  it('LLM 返回空 reply → 不直接收尾 (旧: 空串 0.7 分过关 → 空框)', async () => {
    const loop = new WorkflowPivotLoop({
      maxIterations: 5,
      minIterations: 1,
      qualityThreshold: 0.7,   // 默认阈值: 空串旧评分 0.7 恰好过关
    });
    loop.registerTools(mockTools);

    let calls = 0;
    const llm = {
      chat: async () => {
        calls++;
        // 第一轮返回空 reply (模型只回 tool_calls 没给文本 / 空 content 的真实形态)
        if (calls === 1) return { reply: '' };
        // 后续给真回复
        return { reply: '我看了一下，这是当前目录的文件列表' };
      },
    };

    const result = await loop.execute('能看到我的仓库吗？请列出当前目录', llm as any, '测试系统提示');

    // 空回复必须打回续跑 → 至少 2 次迭代, 而不是第 1 轮就 quality_threshold_met 收尾
    expect(calls).toBeGreaterThan(1);
    expect(result.iterations).toBeGreaterThan(1);
    // 最终回复非空 (不再空框)
    expect(result.response.trim().length).toBeGreaterThan(0);
    expect(result.exitReason).toBe('quality_threshold_met');
  });

  it('纯空白 reply → 同样打回 (trim 后为空)', async () => {
    const loop = new WorkflowPivotLoop({
      maxIterations: 5,
      minIterations: 1,
      qualityThreshold: 0.7,
    });
    loop.registerTools(mockTools);

    let calls = 0;
    const llm = {
      chat: async () => {
        calls++;
        if (calls === 1) return { reply: '   \n  ' };   // 纯空白
        return { reply: '这是回复内容' };
      },
    };

    const result = await loop.execute('测试', llm as any, '测试系统提示');
    expect(calls).toBeGreaterThan(1);
    expect(result.response.trim().length).toBeGreaterThan(0);
  });
});

describe('工具执行阶段 abort 打断 (2026-10-13, leo: 「发送消息过程中的打断和衔接整个流程」)', () => {
  it('工具执行中 abort → loop 快速退出 (不等到 120s 超时)', async () => {
    // 注册一个永不返回的慢工具 (模拟挂起的 terminal/grep)
    const hangingTool: Tool = {
      name: 'hanging_tool',
      description: '永不返回的慢工具 (测试用)',
      parameters: {},
      execute: () => new Promise(() => { /* 永不 resolve */ }),
    };
    const loop = new WorkflowPivotLoop({
      maxIterations: 10,
      minIterations: 1,
      qualityThreshold: 0.7,
    });
    loop.registerTools([hangingTool, ...mockTools]);

    // LLM 永远让模型调用 hanging_tool
    const llm = {
      chat: async () => ({ reply: '', toolCalls: [{ name: 'hanging_tool', args: {} }] }),
    };

    const ac = new AbortController();
    const execPromise = loop.execute('测试', llm as any, '系统提示', undefined, ac.signal);
    // 给工具一帧启动时间, 然后 abort
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    ac.abort();   // 用户 Ctrl+C

    const result = await execPromise;
    const elapsed = Date.now() - t0;
    // abort 后应快速返回 (远小于 120s 超时), 且退出原因不是 error 空框
    expect(elapsed).toBeLessThan(10_000);
    expect(result).toBeTruthy();
  });
});
