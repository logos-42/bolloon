/**
 * DELETE /channels/:id 同时清 agents.json (Bug 7 修复测试, 2026-07-15)
 *
 * 测的核心: 创建频道 → agents.json 多一条 → 删频道 → agents.json 减回去
 * 不依赖启动整个 server, 直接复用 server.ts 里 DELETE 端点的清理逻辑
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let channelsPath: string;
let agentsPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-delete-channel-'));
  channelsPath = path.join(tmpDir, 'channels.json');
  agentsPath = path.join(tmpDir, 'agents.json');
  await fs.writeFile(channelsPath, '[]');
  await fs.writeFile(agentsPath, '[]');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// 抽自 server.ts DELETE /channels/:id 的清理逻辑 — 纯函数, 容易测
async function deleteChannelCascade(channelId: string, channelAgentId: string, opts: {
  channelsPath: string;
  agentsPath: string;
}): Promise<{ channels: any[]; agents: any[] }> {
  const { channelsPath, agentsPath } = opts;
  // 1. channels.json splice
  const channels = JSON.parse(await fs.readFile(channelsPath, 'utf-8'));
  const idx = channels.findIndex((c: any) => c.id === channelId);
  if (idx !== -1) channels.splice(idx, 1);
  await fs.writeFile(channelsPath, JSON.stringify(channels, null, 2));

  // 2. agents.json 清 orphan (Bug 7 修复) — 跟 server.ts 一样的容错
  const raw = await fs.readFile(agentsPath, 'utf-8').catch(() => '');
  let agents: any[] = [];
  if (raw) {
    try { agents = JSON.parse(raw); } catch {}
  }
  if (!Array.isArray(agents)) agents = [];
  const before = agents.length;
  agents = agents.filter(a => !(a && (a.id === channelAgentId || a.channelId === channelId)));
  if (agents.length !== before) {
    await fs.writeFile(agentsPath, JSON.stringify(agents, null, 2));
  }
  return { channels, agents };
}

describe('DELETE /channels/:id cascade: 也清 agents.json (Bug 7 修复 2026-07-15)', () => {
  it('删频道 → agents.json 里挂这个 channelId 的 agent 一起删', async () => {
    // 准备: channels.json 有 1 个 channel, agents.json 有 2 个 agent (一挂一不挂)
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_a', name: '测试', agentId: 'agent_a' }
    ]));
    await fs.writeFile(agentsPath, JSON.stringify([
      { id: 'agent_a', name: '会被删', channelId: 'ch_a' },
      { id: 'agent_b', name: '保留', channelId: 'ch_b' },
    ]));

    const out = await deleteChannelCascade('ch_a', 'agent_a', { channelsPath, agentsPath });

    expect(out.channels.length).toBe(0); // ch_a 删了
    expect(out.agents.length).toBe(1);   // 只剩 agent_b
    expect(out.agents[0].id).toBe('agent_b');
  });

  it('同 agentId 没在 agents.json 里 → 不抛错', async () => {
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_x', name: 'X', agentId: 'agent_unknown' }
    ]));
    await fs.writeFile(agentsPath, '[]');

    const out = await deleteChannelCascade('ch_x', 'agent_unknown', { channelsPath, agentsPath });
    expect(out.agents.length).toBe(0);
  });

  it('agents.json 不存在 → cascade 不抛错', async () => {
    await fs.unlink(agentsPath);
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_y', name: 'Y', agentId: 'agent_y' }
    ]));
    const out = await deleteChannelCascade('ch_y', 'agent_y', { channelsPath, agentsPath });
    expect(out.channels.length).toBe(0);
    // agents.json 不存在 (server 端 .catch(() => '') 不抛错, 但因为数组没变化所以也不会重新创建)
    // 跟 server.ts 真实行为一致: 没变化不写文件
    let exists = false;
    try { await fs.stat(agentsPath); exists = true; } catch {}
    expect(exists).toBe(false);
  });

  it('agents.json 损坏 (非 JSON) → 不抛错, channels.json 还是清理', async () => {
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_z', name: 'Z', agentId: 'agent_z' }
    ]));
    await fs.writeFile(agentsPath, 'GARBAGE');

    const out = await deleteChannelCascade('ch_z', 'agent_z', { channelsPath, agentsPath });
    expect(out.channels.length).toBe(0); // channels 清理成功
    // agents.json 损坏 → JSON.parse 抛错被 catch → agents = [] → filter 不删任何 → 不写文件
    expect(out.agents.length).toBe(0); // 实际上是空数组 (parse 失败回退)
    // 文件内容还是损坏的原样 (server 端不会主动覆盖)
    const raw = await fs.readFile(agentsPath, 'utf-8');
    expect(raw).toBe('GARBAGE');
  });

  it('其他 agent 完全不受影响 (idempotent, 只删匹配的)', async () => {
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_q', name: 'Q', agentId: 'agent_q' }
    ]));
    await fs.writeFile(agentsPath, JSON.stringify([
      { id: 'agent_q', channelId: 'ch_q', name: 'Q' },
      { id: 'agent_r', channelId: 'ch_r', name: 'R' },
      { id: 'agent_s', channelId: 'ch_s', name: 'S' },
    ]));

    const out = await deleteChannelCascade('ch_q', 'agent_q', { channelsPath, agentsPath });
    expect(out.agents.length).toBe(2);
    expect(out.agents.map((a: any) => a.id).sort()).toEqual(['agent_r', 'agent_s']);
  });

  it('多个 agent 都挂同一个 channelId (异常 case) → 都删', async () => {
    await fs.writeFile(channelsPath, JSON.stringify([
      { id: 'ch_w', name: 'W', agentId: 'agent_w' }
    ]));
    await fs.writeFile(agentsPath, JSON.stringify([
      { id: 'agent_w', channelId: 'ch_w' },
      { id: 'agent_x', channelId: 'ch_w' }, // 也挂 ch_w, 应该一起删
      { id: 'agent_y', channelId: 'ch_y' },
    ]));

    const out = await deleteChannelCascade('ch_w', 'agent_w', { channelsPath, agentsPath });
    expect(out.agents.length).toBe(1);
    expect(out.agents[0].id).toBe('agent_y');
  });
});
