/** 三智能体群聊协作门: 三个独立 autopilot 共享同一群消息, 每个主动维护并回写。 */
import { describe, it, expect } from 'vitest';
import { runGroupAutopilotOnce, BOLLOON_MAINTENANCE_RULES, type AutopilotStateFile } from '../agents/group-autopilot.js';
import type { GroupMessage } from '../agents/gateway-group.js';

describe('three agents maintenance group', () => {
  it('只对本地维护群注入三条规则', () => {
    expect(BOLLOON_MAINTENANCE_RULES).toHaveLength(3);
    expect(BOLLOON_MAINTENANCE_RULES.join('\n')).toContain('提升 AI 的意识水平');
    expect(BOLLOON_MAINTENANCE_RULES.join('\n')).toContain('寻求合作');
    expect(BOLLOON_MAINTENANCE_RULES.join('\n')).toContain('突破局部最优');
  });
  it('三个独立智能体主动读取、认领并回写同一群', async () => {
    const messages: GroupMessage[] = [{ id: 'm0', from: 'maintainer-user', text: '请开始维护 Bolloon 项目', ts: 1 }];
    const states: Record<string, AutopilotStateFile> = {
      kernel: { version: 1, groups: {} },
      tester: { version: 1, groups: {} },
      reviewer: { version: 1, groups: {} },
    };
    const outputs: string[] = [];
    for (const agent of ['kernel', 'tester', 'reviewer']) {
      const r = await runGroupAutopilotOnce({
        me: agent,
        listGroups: async () => [{ id: 'maintenance-group', name: 'Bolloon维护群' }],
        readMessages: async () => messages.slice(-20),
        speak: async (_id, text) => { outputs.push(`${agent}: ${text}`); messages.push({ id: `m-${agent}`, from: agent, text, ts: outputs.length + 1 }); return { ok: true }; },
        state: states[agent],
        stateFile: `/tmp/three-agent-${agent}.json`,
        now: () => 10_000,
        policy: { mode: 'maintenance', cooldownMs: 0, maxSpeaksPerHour: 10 },
      });
      expect(r.spoke).toBe(1);
    }
    expect(outputs).toHaveLength(3);
    expect(outputs.every((x) => x.includes('主动维护 Bolloon'))).toBe(true);
    expect(messages.filter((m) => ['kernel', 'tester', 'reviewer'].includes(m.from))).toHaveLength(3);
  });
});
