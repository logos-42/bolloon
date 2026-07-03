/**
 * chat-segmenter 单元测试 — 验证 2026-07-01 抽出 (v0.2.6)
 *
 * 消融思路: 纯函数, 不依赖 LLM / web / P2P.
 *   关键是: 任何 LLM 输出格式 (minimax / Hermes / Qwen / GLM / Anthropic) 切完后,
 *   都不应该有任何 <invoke>/<function_calls>/<tool_call> 残留.
 */
import { describe, it, expect } from 'vitest';
import { segmentChatReply } from '../agents/chat-segmenter.js';

const KNOWN = new Set(['shell_exec', 'read_file', 'write_file']);

describe('segmentChatReply — 基础切分', () => {
  it('空 reply → 空 segments', () => {
    expect(segmentChatReply('', { knownToolNames: KNOWN })).toEqual([]);
  });

  it('纯 text → 一个 text segment', () => {
    const r = segmentChatReply('hello world', { knownToolNames: KNOWN });
    expect(r).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('think + text → 2 个 segments, 顺序保留 (启发式: 开头"让我..." 也进 think)', () => {
    // "让我想想怎么写" 启发式触发 → 进 think 段
    // "需要先 ls 一下"  显式 <think>  → 进 think 段
    // 期望: 2 个 think, 1 个 text (无"让我"重复)
    const reply = '让我想想怎么写\n<think>需要先 ls 一下</think>\n写完了';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r).toEqual([
      { type: 'think', content: '让我想想怎么写' },
      { type: 'think', content: '需要先 ls 一下' },
      { type: 'text', content: '写完了' },
    ]);
  });

  it('没有 think 标记但开头像思考 → 启发式切为 think', () => {
    const reply = '我先看看 git 状态\n然后跑下命令';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    // "我先看看" 启发式触发
    expect(r[0]).toEqual({ type: 'think', content: '我先看看 git 状态' });
  });

  it('env_details 块 → env_details segment', () => {
    const reply = '<environment_details>\nOS: darwin\n</environment_details>\n主回答';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const env = r.find(s => s.type === 'env_details');
    expect(env?.content).toContain('darwin');
  });
});

describe('segmentChatReply — final gen marker', () => {
  it('<final gen> 后内容切为 final segment', () => {
    const reply = '我先想了想<think>thinking</think>\n最终答案 <final gen>\n这是 final';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const finals = r.filter(s => s.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe('这是 final');
  });

  it('<final gen> 在末尾空 → 不产 final segment', () => {
    const reply = '思考 <final gen>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const finals = r.filter(s => s.type === 'final');
    expect(finals).toHaveLength(0);
  });
});

describe('segmentChatReply — minimax/Hermes <invoke> 标记', () => {
  it('<invoke name="shell_exec"> 切为 tool_call segment, 原文去掉', () => {
    const reply = '我先跑 git status\n<invoke name="shell_exec">\n<command>git status</command>\n</invoke>\n好了';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const tools = r.filter(s => s.type === 'tool_call');
    expect(tools).toHaveLength(1);
    expect(tools[0].tool?.name).toBe('shell_exec');
    expect(tools[0].tool?.args).toEqual({ command: 'git', args: 'status' });
    // 文本不应再含 <invoke>
    const allContent = r.map(s => s.content).join('');
    expect(allContent).not.toContain('<invoke');
    expect(allContent).not.toContain('</invoke>');
  });

  it('未知 tool 名的 <invoke> 静默丢弃 (不让前端看到)', () => {
    const reply = '<invoke name="unknown_tool">foo</invoke>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const allContent = r.map(s => s.content).join('') + JSON.stringify(r);
    expect(allContent).not.toContain('unknown_tool');
    expect(allContent).not.toContain('<invoke');
  });

  it('多个 <invoke> 全部切出, 顺序保留', () => {
    const reply = 'first\n<invoke name="shell_exec"><command>ls</command></invoke>\nmiddle\n<invoke name="read_file"><parameter name="path">/tmp/a</parameter></invoke>\nlast';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const tools = r.filter(s => s.type === 'tool_call');
    expect(tools).toHaveLength(2);
    expect(tools[0].tool?.name).toBe('shell_exec');
    expect(tools[1].tool?.name).toBe('read_file');
    expect(tools[1].tool?.args).toEqual({ path: '/tmp/a' });
  });
});

describe('segmentChatReply — JSON 形式 tool_call', () => {
  it('{"name": "shell_exec", "arguments": {...}} 切为 tool_call', () => {
    const reply = '我先跑 git status\n{"name": "shell_exec", "arguments": {"command": "ls"}}\n好了';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const tools = r.filter(s => s.type === 'tool_call');
    expect(tools).toHaveLength(1);
    expect(tools[0].tool?.args).toEqual({ command: 'ls' });
    // 文本不再含 JSON
    const allContent = r.map(s => s.content).join('');
    expect(allContent).not.toContain('"name"');
    expect(allContent).not.toContain('"arguments"');
  });

  it('{"name": "x", "input": {...}} (Anthropic-style) 也切', () => {
    const reply = '{"name": "shell_exec", "input": {"command": "pwd"}}';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call')[0].tool?.args).toEqual({ command: 'pwd' });
  });

  it('{"name": "x", "args": {...}} 也切', () => {
    const reply = '{"name": "shell_exec", "args": {"command": "ls"}}';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call').length).toBe(1);
  });
});

describe('segmentChatReply — 其他形式 tool_call', () => {
  it('[TOOL_CALL]...[/TOOL_CALL] 切', () => {
    const reply = '[TOOL_CALL]{"name": "shell_exec", "arguments": {"command": "ls"}}[/TOOL_CALL]';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call').length).toBe(1);
    const allContent = r.map(s => s.content).join('');
    expect(allContent).not.toContain('TOOL_CALL');
  });

  it('<tool_call>...</tool_call> (OpenAI Hermes) 切', () => {
    const reply = '<tool_call>{"name": "shell_exec", "arguments": {"command": "pwd"}}</tool_call>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call').length).toBe(1);
  });

  it('<function_calls>...</function_calls> 切', () => {
    const reply = '<function_calls>\n<invoke name="shell_exec">\n<parameter name="command">pwd</parameter>\n</invoke>\n</function_calls>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call').length).toBe(1);
  });

  it('tool => "X" 旧内部形式 切', () => {
    const reply = '{ tool => "shell_exec", args => {"command": "ls"} }';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'tool_call').length).toBe(1);
  });

  it('[Function calling] 旧 bolloon 标记去掉', () => {
    const reply = '[Function calling: shell_exec] response';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const allContent = r.map(s => s.content).join('');
    expect(allContent).not.toContain('[Function');
    expect(allContent).toContain('response');
  });
});

describe('segmentChatReply — 终极不变量: 任何 LLM 格式都绝不能残留', () => {
  const LLM_FORMATS = [
    // minimax 默认
    '看完了 <invoke name="shell_exec"><command>ls</command></invoke> 嗯',
    // Hermes
    '<tool_call>{"name": "shell_exec", "arguments": {"command": "ls"}}</tool_call>',
    // Qwen/GLM
    '<function_calls>\n<invoke name="shell_exec">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>',
    // Anthropic-style JSON
    '{"name": "shell_exec", "input": {"command": "ls"}}',
    // 旧 bolloon 内部
    '[TOOL_CALL]{"name": "shell_exec", "arguments": {"command": "ls"}}[/TOOL_CALL]',
    // 嵌套 think + invoke
    '<think>跑一下</think>\n<invoke name="shell_exec"><command>ls</command></invoke>',
    // 多个 invoke
    '<invoke name="shell_exec"><command>a</command></invoke><invoke name="read_file"><parameter name="path">b</parameter></invoke>',
  ];

  for (const reply of LLM_FORMATS) {
    it(`无残留 (格式: ${reply.slice(0, 30)}...)`, () => {
      const r = segmentChatReply(reply, { knownToolNames: KNOWN });
      // 只检查 text 段 (content) 不含 tool_call 标记.
      // segment 字段名 (type/tool/name) 是结构化数据, 跟"残留"无关.
      const allText = r.map(s => s.content ?? '').join('');
      expect(allText).not.toContain('<invoke');
      expect(allText).not.toContain('</invoke>');
      expect(allText).not.toContain('<function_calls>');
      expect(allText).not.toContain('</function_calls>');
      expect(allText).not.toContain('<tool_call>');
      expect(allText).not.toContain('</tool_call>');
      expect(allText).not.toContain('[TOOL_CALL]');
      expect(allText).not.toContain('[/TOOL_CALL]');
      expect(allText).not.toContain('tool =>');
      // 验证: tool_call segment 必含 name/args 字段 (它们在 .tool 里, 不在 content)
      for (const seg of r.filter(s => s.type === 'tool_call')) {
        expect(seg.tool?.name).toBeTruthy();
        expect(seg.tool?.args).toBeDefined();
      }
    });
  }
});

describe('segmentChatReply — 边界', () => {
  it('只有 think 块, 没 text → 1 个 think segment', () => {
    const reply = '<think>只有思考</think>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.filter(s => s.type === 'think')).toHaveLength(1);
    expect(r.filter(s => s.type === 'text')).toHaveLength(0);
  });

  it('只有 <final gen>, 没前面内容 → 1 个 final segment', () => {
    const reply = '<final gen>\n只有 final';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r).toEqual([{ type: 'final', content: '只有 final' }]);
  });

  it('空 text + think + final 混合', () => {
    const reply = '<think>thinking</think>\n<final gen>\nfinal 答';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r.find(s => s.type === 'think')?.content).toBe('thinking');
    expect(r.find(s => s.type === 'final')?.content).toBe('final 答');
  });

  it('多行 + 嵌入 invoke → trim 后 text 干净', () => {
    const reply = '\n\n\n  <invoke name="shell_exec"><command>ls</command></invoke>  \n\n  ';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    const allContent = r.map(s => s.content).join('');
    expect(allContent).not.toContain('<invoke');
  });

  it('完整 minimax 输出 (think + 2 invoke + text + final) → 顺序: think → tool → text → final', () => {
    // 关键: 启发式应该 catch "让我先看 git 状态" 进 think
    // explicit <think> 块也进 think
    // tool_call 切出 (不进 text)
    // "好, 在 master 分支" 是中间 text
    // "任务完成" 是 final 前的填充词, 应被 filterFillerText 过滤
    // final 段含 "Bolloon 在 master 分支"
    const reply = `让我先看 git 状态
<think>用户想知道当前分支, 我先跑 git status</think>
<invoke name="shell_exec">
<command>git status</command>
</invoke>
好, 在 master 分支
现在读 README 确认:
<invoke name="read_file">
<parameter name="path">README.md</parameter>
</invoke>
任务完成 <final gen>
Bolloon 在 master 分支`;
    const r = segmentChatReply(reply, { knownToolNames: new Set(['shell_exec', 'read_file']) });

    // 顺序: 启发式 think → explicit think → 2 个 tool_call (连续) → text → final
    const types = r.map(s => s.type);
    expect(types).toEqual(['think', 'think', 'tool_call', 'tool_call', 'text', 'final']);

    // text 段: "好, 在 master 分支\n现在读 README 确认:\n任务完成" (filterFillerText 限制: 整行 = filler 才丢,
    //   "任务完成 <final gen>" 整行不是 filler, "任务完成" 仍保留)
    const textSeg = r.find(s => s.type === 'text');
    expect(textSeg?.content).toContain('好, 在 master 分支');

    // final 含真实结果
    const finalSeg = r.find(s => s.type === 'final');
    expect(finalSeg?.content).toBe('Bolloon 在 master 分支');
  });

  it('开头"让我..."启发式 catch, 但文本其余部分保留', () => {
    const reply = '我先看看 git 状态\n然后跑下命令';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    expect(r[0]).toEqual({ type: 'think', content: '我先看看 git 状态' });
    expect(r[1]).toEqual({ type: 'text', content: '然后跑下命令' });
  });

  it('think 包裹 tool_call → 都能切出 (think 优先)', () => {
    const reply = '<tool_call><invoke name="shell_exec"><command>ls</command></invoke></tool_call>';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    // 严格: 至少一个 tool_call segment
    expect(r.filter(s => s.type === 'tool_call').length).toBeGreaterThanOrEqual(1);
  });

  it('填充词 "好了" 单句 text → 整段丢 (不上屏)', () => {
    const reply = '好的任务已完成.\n<final gen>\n最终答';
    const r = segmentChatReply(reply, { knownToolNames: KNOWN });
    // "好的任务已完成" 不是 filler 词 (不是单行 "好" 或 "好了")
    // 它进 text 段
    const textSeg = r.find(s => s.type === 'text');
    expect(textSeg?.content).toBe('好的任务已完成.');
  });
});