/**
 * #2 v2 (工具清单分组/按需子集) + #1 收尾 (同签名重复 ⇒ 低门槛引用 stub)。
 * 关键纪律都在这两条门里: **子集只影响"列给模型看的那份"**, 且必须**说明未列出的也能按名字调**(否则就是丢能力);
 *   重复 stub 的门槛必须真的降到 64 —— 512 那档会让 ~90 字符的重复输出(实测 get_identity)从门缝里漏过去。
 */
import { describe, it, expect } from 'vitest';
import { renderToolList, renderToolListWithParams, bucketOf } from '../agents/tool-subset.js';
import { REPEAT_STUB_MIN_CHARS, STUB_MIN_CHARS, observeToolCall, LoopStallState } from '../agents/tool-loop-guard.js';

const NAMES = ['read_file', 'write_file', 'edit_file', 'list_files', 'glob_files', 'grep_files',
  'wallet_get_balance', 'wallet_transfer_token', 'send_to_channel', 'check_inbox', 'list_peers', 'broadcast_message',
  'fetch_url', 'web_search', 'list_tools', 'get_identity', 'update_task', 'list_tasks', 'agent_call', 'delegate_task'];

describe('#2 v2 工具清单: 分组 + 不丢能力', () => {
  it('分类是机械的 (名字决定桶, 不猜)', () => {
    expect(bucketOf('read_file')).toBe('读/找文件');
    expect(bucketOf('wallet_get_balance')).toBe('链上/钱包');
    expect(bucketOf('send_to_channel')).toBe('P2P/沟通');
    expect(bucketOf('list_tools')).toBe('身份/元');
  });
  it('默认档: 分组列出 + 明说"未列出的也能直接按名字调用" (否则就是丢能力)', () => {
    const r = renderToolList(NAMES, '');
    expect(r.text).toContain('【读/找文件】');
    expect(r.text).toContain('【链上/钱包】');
    expect(r.text).toContain('list_tools');
    expect(r.text).toMatch(/未列出的工具也\*\*可以直接按名字调用/);
    expect(r.shown).toBeLessThanOrEqual(r.total);
  });
  it('开关档: 只展开核心 + intent 命中的桶, 且**永远**带 list_tools 与能力提示', () => {
    const r = renderToolList(NAMES, '帮我转点代币', { subset: true });
    expect(r.text).toContain('【链上/钱包】');
    expect(r.text).toContain('list_tools');
    expect(r.text).toContain('未列出的分类');
    const r2 = renderToolList(NAMES, '你好', { subset: true });
    expect(r2.text).toContain('【身份/元】');       // 核心桶永远展开
    expect(r2.text).toContain('list_tools');
  });
});

describe('#2 v2 真正注入的那份: 名字后面必须带参数名', () => {
  it('渲染结果形如 read_file(path,limit) —— 参数名不能丢', () => {
    const r = renderToolListWithParams([
      { name: 'read_file', parameters: { path: '', limit: '' } },
      { name: 'write_file', parameters: { path: '', content: '' } },
      { name: 'list_tools', parameters: { keyword: '' } },
    ], '');
    expect(r.text).toContain('read_file(path,limit)');
    expect(r.text).toContain('write_file(path,content)');
    expect(r.text).toContain('list_tools(keyword)');
    expect(r.text).toMatch(/【读\/找文件】/);
    expect(r.text).toContain('未列出的工具也');
  });
});

describe('#1 收尾: 同签名重复 ⇒ 引用 stub 门槛 64 (不是 512)', () => {
  const state = () => new LoopStallState();
  it('89 字符的重复输出 (实测 get_identity 量级) 必须被 stub 掉', () => {
    const text = '名称: 小龙\n' + 'x'.repeat(80);
    const obs = observeToolCall(state(), {
      toolName: 'get_identity', args: {}, resultText: text, ok: true,
      seenResultBefore: true, sameSignatureBefore: true,
    });
    expect(text.length).toBeGreaterThan(REPEAT_STUB_MIN_CHARS);
    expect(text.length).toBeLessThan(STUB_MIN_CHARS);          // 512 那档抓不到它
    expect(obs.stub, '重复且同签名 ⇒ 应该给引用 stub').toBeTruthy();
  });
  it('首次调用 / 不同签名 ⇒ 不替换 (该给的原文照给)', () => {
    const text = 'x'.repeat(100);
    expect(observeToolCall(state(), { toolName: 'read_file', args: {}, resultText: text, ok: true, seenResultBefore: false }).stub).toBeUndefined();
    expect(observeToolCall(state(), { toolName: 'read_file', args: {}, resultText: text, ok: true, seenResultBefore: true, sameSignatureBefore: false }).stub).toBeUndefined();
  });
});
