/**
 * tool-name 测试 — 锁住「工具名出网净化 + 回程派发还原」这条链路 (2026-09-26)
 *
 * 背景: `contact.list_authorized` 这类带点的工具名会让整个请求 400
 *   (Invalid 'tools[120].function.name': string does not match pattern).
 * 本文件锁的是:
 *   ① 净化确定性 (非法字符 → '_', 超长 → 截断 + 稳定 hash 后缀, 幂等)
 *   ② 碰撞**不许静默** (两个不同原名净化后同名 → 抛错并点两个原名)
 *   ③ 派发不断 (API 名 → 真名 → 真 handler, 不是"名字对了但实现没跑到")
 *   ④ 无名/空名 → 拒绝发包
 */
import { describe, it, expect } from 'vitest';
import {
  TOOL_NAME_PATTERN,
  sanitizeToolName,
  isValidToolName,
  illegalCharsOf,
  ToolNameRouteTable,
  ToolNameCollisionError,
  sanitizeToolsForApi,
  resolveApiToolName,
  expandKnownToolNames,
} from '../llm/tool-name.js';

describe('sanitizeToolName', () => {
  it('非法字符 (点) → 下划线', () => {
    expect(sanitizeToolName('contact.list_authorized')).toBe('contact_list_authorized');
  });

  it('一堆非法字符 (空格/冒号/斜杠/中文) 全部变成 _', () => {
    // '技能: 读/写 文件' = 10 个字符全是非法字符 ⇒ 10 个下划线
    expect(sanitizeToolName('技能: 读/写 文件')).toBe('_'.repeat(10));
    expect(TOOL_NAME_PATTERN.test(sanitizeToolName('技能: 读/写 文件'))).toBe(true);
    expect(illegalCharsOf('技能: 读/写 文件')).toEqual(['技', '能', ':', ' ', '读', '/', '写', '文', '件']);
  });

  it('合法名原样不动 (幂等)', () => {
    for (const n of ['read_file', 'shell_exec', 'contact-list', 'A1_b2-C3']) {
      expect(sanitizeToolName(n)).toBe(n);
      expect(sanitizeToolName(sanitizeToolName(n))).toBe(n);
      expect(isValidToolName(n)).toBe(true);
    }
  });

  it('超长 (65+) → 截到 64 且带稳定 hash 后缀; 同前缀不同名不撞', () => {
    const a = 'x'.repeat(80) + 'a';
    const b = 'x'.repeat(80) + 'b';
    const sa = sanitizeToolName(a);
    const sb = sanitizeToolName(b);
    expect(sa.length).toBe(64);
    expect(sb.length).toBe(64);
    expect(TOOL_NAME_PATTERN.test(sa)).toBe(true);
    expect(TOOL_NAME_PATTERN.test(sb)).toBe(true);
    expect(sa).not.toBe(sb); // 不撞 (后缀是内容 hash)
    expect(sanitizeToolName(a)).toBe(sa); // 确定性
    expect(sa.startsWith('x'.repeat(55) + '_')).toBe(true);
  });

  it('正好 64 不动, 65 才截', () => {
    const n64 = 'y'.repeat(64);
    expect(sanitizeToolName(n64)).toBe(n64);
    expect(sanitizeToolName('y'.repeat(65)).length).toBe(64);
  });
});

describe('ToolNameRouteTable — 原名 ↔ API 名', () => {
  it('原名 → API 名 → 原名 往返一致', () => {
    const t = new ToolNameRouteTable();
    const api = t.register('contact.await_reply');
    expect(api).toBe('contact_await_reply');
    expect(t.resolveToOriginal('contact_await_reply')).toBe('contact.await_reply');
    expect(t.resolveToOriginal('contact.await_reply')).toBe('contact.await_reply'); // 原名穿透
    expect(t.resolveToOriginal('编造的_名字')).toBe('编造的_名字'); // 未知名穿透 (交给未知工具分支)
    expect(t.changed).toEqual([{ original: 'contact.await_reply', api: 'contact_await_reply', changed: true }]);
  });

  it('碰撞不许静默: 两个不同原名净化后同名 → 抛错点名两个', () => {
    const t = new ToolNameRouteTable();
    t.register('contact.send');
    let err: any;
    try {
      t.register('contact send'); // 空格 → '_' ⇒ 与上一个同名
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolNameCollisionError);
    expect(err.apiName).toBe('contact_send');
    expect(err.names).toEqual(['contact.send', 'contact send']);
    expect(String(err.message)).toContain('contact.send');
    expect(String(err.message)).toContain('contact send');
  });

  it('同一个原名重复登记不算碰撞', () => {
    const t = new ToolNameRouteTable();
    expect(t.register('contact.send')).toBe('contact_send');
    expect(t.register('contact.send')).toBe('contact_send');
    expect(t.size).toBe(1);
  });
});

describe('sanitizeToolsForApi — 出网工具面', () => {
  const tool = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

  it('每个 function.name 净化后都合法; 原名不被改写 (入参不可变)', () => {
    const t = new ToolNameRouteTable();
    const input = [tool('read_file'), tool('contact.list_authorized'), tool('技能:读')];
    const out = sanitizeToolsForApi(input, t);
    for (const o of out) expect(isValidToolName(o.function.name)).toBe(true);
    expect(out.map((o) => o.function.name)).toEqual(['read_file', 'contact_list_authorized', expect.stringMatching(TOOL_NAME_PATTERN)]);
    expect(input.map((o) => o.function.name)).toEqual(['read_file', 'contact.list_authorized', '技能:读']); // 原数组没被改
  });

  it('无名 / 空名 → 拒绝发包 (点名第几个)', () => {
    const t = new ToolNameRouteTable();
    expect(() => sanitizeToolsForApi([tool('ok_tool'), { type: 'function', function: {} } as any], t)).toThrow(/#1/);
    expect(() => sanitizeToolsForApi([tool('')], t)).toThrow(/function\.name/);
  });

  it('回归: 6 个 contact.* 工具全能净化且往返还原', () => {
    const t = new ToolNameRouteTable();
    const names = ['contact.list_authorized', 'contact.preview', 'contact.request_consent', 'contact.send', 'contact.await_reply', 'contact.revoke'];
    const out = sanitizeToolsForApi(names.map(tool), t);
    const apis = out.map((o) => o.function.name);
    expect(new Set(apis).size).toBe(6);
    for (let i = 0; i < names.length; i++) expect(t.resolveToOriginal(apis[i])).toBe(names[i]);
  });
});

describe('派发不断 — API 名真的走到真 handler', () => {
  it('拿净化名 (LLM 回吐的形状) 能打到真实现, 不是"名字对了实现没跑"', async () => {
    // 真 handler: 名字被改写过的工具, 内部只认自己收到的 args
    const calls: string[] = [];
    const tools = new Map<string, any>();
    tools.set('contact.await_reply', {
      name: 'contact.await_reply',
      description: '等回复',
      parameters: {},
      execute: async (args: any) => {
        calls.push('contact.await_reply');
        return { success: true, output: `真 handler 跑到: ${args.contactId}` };
      },
    });
    // 出网侧: 工具面里这个名字是净化过的
    const table = new ToolNameRouteTable();
    const wire = sanitizeToolsForApi([{ type: 'function', function: { name: 'contact.await_reply' } }], table);
    expect(wire[0].function.name).toBe('contact_await_reply');
    // 回程侧: LLM 回吐 API 名 → 还原 → 真 handler
    const inbound = resolveApiToolName(wire[0].function.name, table);
    const tool = tools.get(inbound);
    expect(tool).toBe(tools.get('contact.await_reply'));
    const r = await tool.execute({ contactId: 'c-42' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('c-42');
    expect(calls).toEqual(['contact.await_reply']);
    // 只用 API 名直接查表 (不做还原) 是查不到的 —— 证明还原这一步真在承重
    expect(tools.get(wire[0].function.name)).toBeUndefined();
  });

  it('expandKnownToolNames: 文本解析路径的已知名集合同时含原名和 API 名', () => {
    const t = new ToolNameRouteTable();
    const known = expandKnownToolNames(['read_file', 'contact.send'], t);
    expect(known.has('read_file')).toBe(true);
    expect(known.has('contact.send')).toBe(true);
    expect(known.has('contact_send')).toBe(true);
    expect(t.resolveToOriginal('contact_send')).toBe('contact.send');
  });
});
