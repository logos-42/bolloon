/**
 * ReAct Loop 决策层单元测试 — 验证 2026-06-30 抽出
 *
 * 消融思路: 完全脱离 PiAgentSession (不调 LLM, 不动状态, 不写 history),
 *   只测 decideNext 一个纯函数 + 几个 sentinel 检测函数.
 *
 * claude code / 外部 harness 可以直接 import 这个模块,
 *   验证"输入 reply + known tools, 输出 next action"行为契约.
 */
import { describe, it, expect } from 'vitest';
import {
  decideNext,
  isAiFailureSentinel,
  extractFinalText,
  shouldForceExit,
  shouldHintToStopSameTool,
  type StepContext,
} from '../agents/react-loop.js';

const KNOWN = new Set(['shell_exec', 'read_file', 'write_file', 'git_log']);

describe('decideNext — 主决策表', () => {
  it('空 reply → continue (no-tool-no-final)', () => {
    expect(decideNext({ reply: '', knownToolNames: KNOWN })).toEqual({
      kind: 'continue',
      reason: 'no-tool-no-final',
    });
  });

  it('普通文本回复 → continue', () => {
    expect(decideNext({ reply: '我看了下, 没问题', knownToolNames: KNOWN }).kind).toBe('continue');
  });

  it('AI failure sentinel ([AI 服务调用失败]) → continue', () => {
    const r = decideNext({
      reply: '[AI 服务调用失败] 网络超时',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('continue');
    expect(r.reason).toBe('ai-failure-sentinel');
  });

  it('AI failure sentinel ([AI 调用失败]) → continue', () => {
    expect(decideNext({
      reply: '[AI 调用失败] rate limit',
      knownToolNames: KNOWN,
    }).reason).toBe('ai-failure-sentinel');
  });

  it('AI failure sentinel ([错误:...]) → continue', () => {
    expect(decideNext({
      reply: '[错误: api down]',
      knownToolNames: KNOWN,
    }).reason).toBe('ai-failure-sentinel');
  });

  it('parseToolCall 命中 (JSON 形式) → execute-tool', () => {
    const r = decideNext({
      reply: '{"name": "shell_exec", "arguments": {"command": "git", "args": "status"}}',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('execute-tool');
    if (r.kind === 'execute-tool') {
      expect(r.name).toBe('shell_exec');
      expect(r.args).toEqual({ command: 'git', args: 'status' });
    }
  });

  it('parseToolCall 命中 (XML 形式) → execute-tool', () => {
    const r = decideNext({
      reply: '<invoke name="shell_exec"><command>git status</command></invoke>',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('execute-tool');
    if (r.kind === 'execute-tool') {
      expect(r.name).toBe('shell_exec');
    }
  });

  it('parseToolCall + final gen 混合 → execute-tool (工具优先)', () => {
    // 这是 2026-06-19 修的 bug: 之前 isFinalResponse 提前 break
    const r = decideNext({
      reply: `让我跑完给你 <final gen>
<invoke name="shell_exec">
<command>git status</command>
</invoke>`,
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('execute-tool');
  });

  it('parseToolCall 命中但 tool 不在 known set → 当前 design: null → continue', () => {
    // 当前 parseToolCall 对未知 name 直接 null (没 alias 命中 + tools.has false → null).
    //   所以 decideNext 看到的是 continue (no-tool-no-final).
    // 旧 pi-sdk.ts:3253 的 9 正则全匹配路径里, 不在 knownSet 也会进 undefined 分支.
    const r = decideNext({
      reply: '{"name": "completely-fake-tool", "arguments": {}}',
      knownToolNames: KNOWN,
    });
    // 不在 knownSet + parseToolCall 返回 null → continue
    expect(r.kind).toBe('continue');
  });

  it('含 <final gen> 且无 tool_call → final', () => {
    const r = decideNext({
      reply: '任务完成 <final gen> 给你答案',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('final');
    if (r.kind === 'final') {
      expect(r.reason).toBe('final-gen-marker');
    }
  });

  it('思考块里说 "再 <final gen>" 也先看是不是工具 → 这里无工具, 走 final', () => {
    const r = decideNext({
      reply: '我先想一想, 然后 <final gen>',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('final');
  });

  it('思考块 + invoke 真实工具混合 → execute-tool (think 不阻断)', () => {
    const r = decideNext({
      reply: '让我想想, 然后跑下\n<invoke name="shell_exec"><command>ls</command></invoke>',
      knownToolNames: KNOWN,
    });
    expect(r.kind).toBe('execute-tool');
  });

  it('signal aborted → continue (上游终止)', () => {
    const r = decideNext({
      reply: '正常回复 <final gen>',
      knownToolNames: KNOWN,
      signalAborted: true,
    });
    expect(r.kind).toBe('continue');
    expect(r.reason).toBe('signal-aborted-upstream');
  });

  it('atMaxIterations → final (fail-safe 终止)', () => {
    const r = decideNext({
      reply: '还在跑 ...',
      knownToolNames: KNOWN,
      atMaxIterations: true,
    });
    expect(r.kind).toBe('final');
    expect(r.reason).toBe('max-iterations');
  });

  it('atMaxIterations 优先级高于 parseToolCall (fail-safe 立即终止)', () => {
    const r = decideNext({
      reply: '<invoke name="shell_exec"><command>pwd</command></invoke>',
      knownToolNames: KNOWN,
      atMaxIterations: true,
    });
    expect(r.kind).toBe('final');
    expect(r.reason).toBe('max-iterations');
  });
});

describe('isAiFailureSentinel — 哨兵检测', () => {
  it('官方哨兵前缀三种都识别', () => {
    expect(isAiFailureSentinel('[AI 服务调用失败] 网络超时')).toBe(true);
    expect(isAiFailureSentinel('[AI 调用失败] rate limit')).toBe(true);
    expect(isAiFailureSentinel('[错误: api down]')).toBe(true);
  });

  it('空 / 普通回复不识别', () => {
    expect(isAiFailureSentinel('')).toBe(false);
    expect(isAiFailureSentinel('正常回复')).toBe(false);
    expect(isAiFailureSentinel('前面有 [AI 服务调用失败] 字符串但不是开头的')).toBe(false);
  });

  it('忽略前后空白后判断', () => {
    expect(isAiFailureSentinel('   [AI 服务调用失败] 网络  ')).toBe(true);
  });
});

describe('extractFinalText — final 答案抽取', () => {
  it('有 <final gen> 后内容 → 抽出来', () => {
    expect(extractFinalText('思考 思考 <final gen>\n最终答案')).toBe('最终答案');
  });

  it('<final gen> 在末尾空 → fallback 用之前内容', () => {
    expect(extractFinalText('我是答案 <final gen>')).toBe('我是答案');
  });

  it('无 marker → 整段返回', () => {
    expect(extractFinalText('直接说: 这是答案')).toBe('直接说: 这是答案');
  });

  it('可自定义 marker', () => {
    // 当前实现: marker 后内容 trim()
    expect(extractFinalText('思考 [END] 最终', '[END]')).toBe('最终');
  });
});

describe('shouldForceExit + shouldHintToStopSameTool — 终止条件', () => {
  it('shouldForceExit 累计错误达到上限', () => {
    expect(shouldForceExit(3, 3)).toBe(true);
    expect(shouldForceExit(2, 3)).toBe(false);
    expect(shouldForceExit(100, 50)).toBe(true);
  });

  it('边界 — 上限为 0 时永远退', () => {
    expect(shouldForceExit(0, 0)).toBe(true);
    expect(shouldForceExit(1, 0)).toBe(true);
  });

  it('shouldHintToStopSameTool 同一工具连续失败 N 次提示', () => {
    expect(shouldHintToStopSameTool(2, 3)).toBe(false);
    expect(shouldHintToStopSameTool(3, 3)).toBe(true);
    expect(shouldHintToStopSameTool(0, 3)).toBe(false);
  });
});

describe('decideNext — 全场景组合', () => {
  const cases: Array<{ desc: string; ctx: StepContext; expected: string; reason?: string }> = [
    {
      desc: '信号已断 + 还有工具要跑',
      ctx: { reply: '<invoke name="shell_exec"><command>ls</command></invoke>', knownToolNames: KNOWN, signalAborted: true },
      expected: 'continue',
      reason: 'signal-aborted-upstream',
    },
    {
      desc: '到达最大迭代 + 含 tool_call',
      ctx: { reply: '<invoke name="shell_exec"><command>ls</command></invoke>', knownToolNames: KNOWN, atMaxIterations: true },
      expected: 'final',
      reason: 'max-iterations',
    },
    {
      desc: 'AI 失败 sentinel 在 reply 开头 (无 tool_call)',
      ctx: { reply: '[AI 服务调用失败] 网络超时', knownToolNames: KNOWN },
      expected: 'continue',
      reason: 'ai-failure-sentinel',
    },
    {
      desc: 'reply 含 tool_call + 中段嵌 sentinel (实际: tool_call 优先, sentinel 中段不计)',
      ctx: { reply: '<invoke name="shell_exec"><command>ls</command></invoke>\n[AI 服务调用失败] timeout', knownToolNames: KNOWN },
      expected: 'execute-tool',
      reason: 'parse-tool-call',
    },
    {
      desc: '正常 text 无 tool_call 无 final',
      ctx: { reply: '继续想想...' , knownToolNames: KNOWN },
      expected: 'continue',
      reason: 'no-tool-no-final',
    },
    {
      desc: '正常 final 终止',
      ctx: { reply: '答案就这 <final gen>', knownToolNames: KNOWN },
      expected: 'final',
      reason: 'final-gen-marker',
    },
    {
      desc: '工具有效且完整',
      ctx: { reply: '{"name": "read_file", "arguments": {"path": "/tmp/x"}}', knownToolNames: KNOWN },
      expected: 'execute-tool',
    },
    {
      desc: 'JSON 形式 + alias resolve fail',
      ctx: { reply: '{"name": "bash", "arguments": {"command": "ls"}}', knownToolNames: new Set(['read_file']) },
      // bash → shell_exec (alias) 不在 knownSet, parseToolCall 返 null
      expected: 'continue',
    },
  ];
  for (const { desc, ctx, expected, reason } of cases) {
    it(desc, () => {
      const r = decideNext(ctx);
      expect(r.kind).toBe(expected);
      if (reason && 'reason' in r) expect(r.reason).toBe(reason);
    });
  }
});
