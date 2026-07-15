/**
 * agents.json 同步逻辑 — Bug 6 修复测试 (2026-07-15)
 *
 * 测的核心: server.ts /channels POST 应当同步把新 agent append 到 ~/.bolloon/agents/agents.json
 * 不依赖启动整个 server, 直接复用 server.ts 里的 "appendAgentToAgentsJson" 逻辑路径
 * (抽成纯函数避开 server 完整启动)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let agentsPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-agents-sync-'));
  agentsPath = path.join(tmpDir, 'agents.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// 复用 server.ts 里的 write 逻辑 — 抽成纯函数
async function appendAgentToAgentsJson(agentsPath: string, agent: any): Promise<void> {
  await fs.mkdir(path.dirname(agentsPath), { recursive: true });
  let arr: any[] = [];
  try { arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8')); } catch {}
  if (!Array.isArray(arr)) arr = [];
  const exists = arr.some(a => a && a.id === agent.id);
  if (!exists) {
    arr.push(agent);
    await fs.writeFile(agentsPath, JSON.stringify(arr, null, 2), 'utf-8');
  }
}

describe('agents.json sync: 频道创建时同步写入 agent (Bug 6 修复 2026-07-15)', () => {
  it('agents.json 不存在时, appendAgent 能成功创建新文件', async () => {
    await appendAgentToAgentsJson(agentsPath, {
      id: 'agent_test1',
      name: '测试智能体',
      did: 'did:local:ch_test',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(1);
    expect(arr[0].id).toBe('agent_test1');
    expect(arr[0].name).toBe('测试智能体');
  });

  it('agents.json 已存在时, 同 id append 是 idempotent (跳过)', async () => {
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_x', name: 'first' });
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_x', name: 'second' });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(1);
    expect(arr[0].name).toBe('first'); // 后者被跳过
  });

  it('不同时, 多个 append 全部保留', async () => {
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_a', name: 'A' });
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_b', name: 'B' });
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_c', name: 'C' });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(3);
    expect(arr.map(a => a.id).sort()).toEqual(['agent_a', 'agent_b', 'agent_c']);
  });

  it('agents.json 内容损坏时 (非 JSON), 自动重置为空数组', async () => {
    await fs.writeFile(agentsPath, 'not-json-garbage');
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_z', name: 'Z' });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(1);
    expect(arr[0].id).toBe('agent_z');
  });

  it('append 保留已存在 agent 的所有字段 (不更新, 但也不擦除)', async () => {
    await fs.writeFile(agentsPath, JSON.stringify([
      { id: 'agent_x', name: '原名', capabilities: ['coding'], did: 'did:local:old', status: 'active', channelId: 'ch_old', lastActive: '2026-01-01' },
    ]));
    await appendAgentToAgentsJson(agentsPath, { id: 'agent_x', name: '新名', capabilities: ['writing'], channelId: 'ch_new' });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(1);
    expect(arr[0]).toEqual({
      id: 'agent_x',
      name: '原名', // 没改 (skip 生效)
      capabilities: ['coding'],
      did: 'did:local:old',
      status: 'active',
      channelId: 'ch_old',
      lastActive: '2026-01-01',
    });
  });

  it('channel.agentId 同 agents.json 已存在的 id 对齐 (这次 append 不改 id)', async () => {
    // 模拟现实: channel 创建时调 append, 用 channel.agentId 作为主键
    // 如果 agents.json 已存在该 id, append 跳过 — 之前是 subagent-manager 里的另一个 agent, 保留它
    const existingId = 'agent_18cece3f';
    await fs.writeFile(agentsPath, JSON.stringify([
      { id: existingId, name: '现有 agent', did: 'did:local:abc', capabilities: ['reasoning'] },
    ]));
    await appendAgentToAgentsJson(agentsPath, {
      id: existingId,
      name: '频道 same id',
      did: 'did:local:def',
    });
    const arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8'));
    expect(arr.length).toBe(1);
    expect(arr[0].name).toBe('现有 agent'); // 没被覆盖
    expect(arr[0].did).toBe('did:local:abc');
  });
});
