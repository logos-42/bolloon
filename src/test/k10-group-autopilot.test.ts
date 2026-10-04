/**
 * k10-group-autopilot.test.ts — 2026-10-02 (leo: 「拉取在里面阅读的内容并进行自主发言, 希望人工智能自己搞定」)
 *
 * 判据:
 *   A. decideGroupAction 是**纯决策** (不碰时钟/不碰 I/O): 该说三种 + 不该说四种;
 *   B. 回路 runGroupAutopilotOnce: 该说才说 · 幂等 (同一条只说一次) · 读/说失败进 errors 不抛;
 *   C. messageKey 没有 id 时的退化指纹 (不假造 id) · looksLikeRequest 的形状;
 *   D. 状态文件是纯状态 (group-autopilot.json), 不含任何密钥字段。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  decideGroupAction,
  runGroupAutopilotOnce,
  messageKey,
  looksLikeRequest,
  groupState,
  autopilotStatePath,
  DEFAULT_AUTOPILOT_POLICY,
  type AutopilotStateFile,
} from '../agents/group-autopilot.js';
import type { GroupMessage } from '../agents/gateway-group.js';

const ME = 'agent-me';
const emptyState = (): AutopilotStateFile => ({ version: 1, groups: {} });
const msg = (o: Partial<GroupMessage>): GroupMessage => ({ from: 'other', text: 'hi', ts: 1000, ...o }) as GroupMessage;

describe('A. decideGroupAction —— 纯决策', () => {
  const base = { me: ME, now: 10_000_000, state: { seen: [], spokeAt: [] } };

  it('没有别人的新消息 ⇒ 静默', () => {
    expect(decideGroupAction({ ...base, msgs: [] }).act).toBe('silent');
    expect(decideGroupAction({ ...base, msgs: [msg({ from: ME })] }).act).toBe('silent');
  });

  it('① 有人 @我 ⇒ 说, 且**回复那一条** + 带上对方', () => {
    const d = decideGroupAction({ ...base, msgs: [msg({ id: 'h9', from: '张三', text: '看下', mentions: ['agent-me'] })] });
    expect(d.act).toBe('speak');
    if (d.act !== 'speak') throw new Error('unreachable');
    expect(d.reason).toContain('@');
    expect(d.replyTo).toBe('h9');
    expect(d.mentions).toEqual(['张三']);
  });

  it('② 没人 @我, 但有人在问/请人做事 ⇒ 说一次', () => {
    expect(decideGroupAction({ ...base, msgs: [msg({ from: '李四', text: '这个口径谁确认一下？' })] }).act).toBe('speak');
    expect(decideGroupAction({ ...base, msgs: [msg({ from: '李四', text: '麻烦帮忙看下构建' })] }).act).toBe('speak');
  });

  it('③ 纯闲聊 (没 @我、也没提问) ⇒ 静默 (不许没事找话说)', () => {
    const d = decideGroupAction({ ...base, msgs: [msg({ from: '王五', text: '今天天气不错' })] });
    expect(d.act).toBe('silent');
    expect(d.reason).toContain('没有');
  });

  it('④ 已处理过 (seen) ⇒ 静默; 只说一次', () => {
    const m = msg({ id: 'h1', from: '张三', text: '在吗？' });
    const state = { seen: [messageKey(m)], spokeAt: [] };
    expect(decideGroupAction({ ...base, state, msgs: [m] }).act).toBe('silent');
  });

  it('⑤ 冷却中 ⇒ 静默 (即使被 @)', () => {
    const d = decideGroupAction({
      ...base,
      state: { seen: [], spokeAt: [base.now - 10_000] },
      msgs: [msg({ id: 'h2', from: '张三', text: '看下', mentions: [ME] })],
    });
    expect(d.act).toBe('silent');
    expect(d.reason).toContain('冷却');
  });

  it('⑥ 超过每小时上限 ⇒ 静默', () => {
    const spokeAt = Array.from({ length: DEFAULT_AUTOPILOT_POLICY.maxSpeaksPerHour }, (_, i) => base.now - 60_000 - i * 1000);
    const d = decideGroupAction({ ...base, state: { seen: [], spokeAt }, msgs: [msg({ id: 'h3', from: '张三', text: '看下', mentions: [ME] })] });
    expect(d.act).toBe('silent');
    expect(d.reason).toContain('上限');
  });

  it('纯函数: 同一输入两次结果一样, 且不改入参', () => {
    const state = { seen: [], spokeAt: [] };
    const msgs = [msg({ id: 'h4', from: '张三', text: '看下', mentions: [ME] })];
    const a = decideGroupAction({ ...base, state, msgs });
    const b = decideGroupAction({ ...base, state, msgs });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(state.seen).toEqual([]);       // 决策不写状态 (写状态是回路的活)
  });
});

describe('B. 回路: 该说才说 · 幂等 · 失败不抛', () => {
  function mkPorts(over: Partial<Parameters<typeof runGroupAutopilotOnce>[0]> = {}) {
    const spoke: Array<{ group: string; text: string; opts?: { replyTo?: string; mentions?: string[] } }> = [];
    const state = emptyState();
    const ports = {
      me: ME,
      listGroups: async () => [{ id: 'g1', name: '测试群' }],
      readMessages: async () => [msg({ id: 'h1', from: '张三', text: '看下', mentions: [ME] })],
      speak: async (group: string, text: string, opts?: { replyTo?: string; mentions?: string[] }) => {
        spoke.push({ group, text, ...(opts ? { opts } : {}) });
        return { ok: true };
      },
      state,
      now: () => 10_000_000,
      ...over,
    };
    return { ports, spoke, state };
  }

  it('被 @ ⇒ 说一次, 且带上 replyTo/mentions', async () => {
    const { ports, spoke } = mkPorts();
    const r = await runGroupAutopilotOnce(ports as never);
    expect(r.spoke).toBe(1);
    expect(spoke[0].group).toBe('g1');
    expect(spoke[0].opts?.replyTo).toBe('h1');
    expect(spoke[0].opts?.mentions).toEqual(['张三']);
  });

  it('跑第二遍 ⇒ 静默 (同一条不会说两次)', async () => {
    const { ports } = mkPorts();
    await runGroupAutopilotOnce(ports as never);
    const r2 = await runGroupAutopilotOnce(ports as never);
    expect(r2.spoke).toBe(0);
    expect(r2.details[0]).toContain('静默');
  });

  it('读消息失败 ⇒ 进 errors, 不抛, 也不发言', async () => {
    const { ports, spoke } = mkPorts({ readMessages: async () => { throw new Error('群组 store 不可达'); } });
    const r = await runGroupAutopilotOnce(ports as never);
    expect(r.spoke).toBe(0);
    expect(r.errors.join(' ')).toContain('store 不可达');
    expect(spoke).toEqual([]);
  });

  it('发言失败 ⇒ 进 errors, 且**不记** spokeAt (下轮还能再试)', async () => {
    const { ports, state } = mkPorts({ speak: async () => ({ ok: false, error: '库被占着' }) });
    const r = await runGroupAutopilotOnce(ports as never);
    expect(r.errors.join(' ')).toContain('库被占着');
    expect(groupState(state, 'g1').spokeAt).toEqual([]);
  });

  it('纯闲聊 ⇒ 静默 (回路也不会没事找话)', async () => {
    const { ports, spoke } = mkPorts({ readMessages: async () => [msg({ from: '王五', text: '今天天气不错' })] });
    const r = await runGroupAutopilotOnce(ports as never);
    expect(r.spoke).toBe(0);
    expect(spoke).toEqual([]);
  });
});

describe('C. 指纹与形状', () => {
  it('有 id 用 id; 没有 id 退化成 from|ts|text 指纹 (不假造)', () => {
    expect(messageKey(msg({ id: 'h1' }))).toBe('id:h1');
    const k = messageKey(msg({ from: 'a', ts: 5, text: 'x'.repeat(60) }));
    expect(k.startsWith('fp:a|5|x')).toBe(true);
    expect(k.length).toBeLessThan(60);
  });
  it('looksLikeRequest: 问号/吗/请问/麻烦/请… 算; 陈述句不算', () => {
    for (const t of ['这样行吗？', '请问口径', '麻烦帮忙', '请确认', '谁来定？']) expect(looksLikeRequest(t), t).toBe(true);
    for (const t of ['今天天气不错', '已完成', '好的', '']) expect(looksLikeRequest(t), t).toBe(false);
  });
});

describe('D2. 回路已接成 AI 可调用的工具 (AI 自己开回路)', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf8');
  it('group_autopilot 工具在册, 且三个动作 + 端口接线齐全', () => {
    expect(src).toMatch(/ctx\.tools\.set\('group_autopilot'/);
    expect(src).toMatch(/runGroupAutopilotOnce\(ports\)/);
    expect(src).toMatch(/startGroupAutopilot\(\{ \.\.\.ports, intervalMs \}\)/);
    expect(src).toMatch(/autopilotHandle\.stop\(\)/);
    // 发言仍走唯一出口 (带隐私闸), 不是直连 groupSend
    expect(src).toMatch(/sendTrailMessage\(gid, text, who\.tag, opts \?\? \{\}\)/);
  });
});

describe('D. 状态文件是纯状态', () => {
  it('路径是 group-autopilot.json, 且在 BOLLOON_HOME 下', () => {
    const old = process.env.BOLLOON_HOME;
    process.env.BOLLOON_HOME = '/tmp/autopilot-test-home';
    try {
      expect(autopilotStatePath()).toBe('/tmp/autopilot-test-home/group-autopilot.json');
    } finally {
      if (old === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = old;
    }
  });
});
