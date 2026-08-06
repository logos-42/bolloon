/**
 * agent-identity-store.test.ts — 统一 Agent Identity Store 单测 (2026-08-06)
 * tmp HOME 隔离, 不碰真实 ~/.bolloon。
 * 覆盖: resolve 三种解析 (number/id/name) + setActive 持久化 + getActive 恢复 + 优先级
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AgentIdentityStore, channelsPaths, activeChannelFile } from '../agents/agent-identity-store.js';

async function makeTmpHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-identity-test-'));
  // channels.json 放 sessions/ 子目录 (与真实路径对齐)
  await fs.mkdir(path.join(dir, '.bolloon', 'sessions'), { recursive: true });
  const channels = [
    { id: 'ch-research', name: 'research-channel', agentId: 'agent-research', persona: { name: 'ResearchAgent', description: '研究助手' } },
    { id: 'ch-trade', name: 'trade-channel', agentId: 'agent-trade', persona: { name: 'TradeAgent', personality: '交易' } },
    { id: 'ch-meta', name: 'meta-channel', agentId: 'agent-meta' }, // 无 persona → 用 name
  ];
  await fs.writeFile(channelsPaths(dir)[0], JSON.stringify(channels), 'utf-8');
  return dir;
}

describe('AgentIdentityStore', () => {
  let home: string;
  let store: AgentIdentityStore;

  beforeEach(async () => {
    home = await makeTmpHome();
    store = new AgentIdentityStore(home);
  });

  it('getIdentities: persona.name 优先, 无 persona 用 channel.name', async () => {
    await store.load();
    const ids = store.getIdentities();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatchObject({ id: 'ch-research', name: 'ResearchAgent', channelId: 'ch-research' });
    expect(ids[2]).toMatchObject({ name: 'meta-channel' }); // 无 persona → channel.name
  });

  it('resolve: number 按 1-based 索引', async () => {
    const r = await store.resolve('1');
    expect(r).not.toBeNull();
    expect(r!.match).toBe('number');
    expect(r!.index).toBe(1);
    expect(r!.identity.name).toBe('ResearchAgent');
    expect((await store.resolve('3'))!.identity.name).toBe('meta-channel');
    expect(await store.resolve('99')).toBeNull();
  });

  it('resolve: id 完整/前缀匹配', async () => {
    const full = await store.resolve('ch-trade');
    expect(full!.match).toBe('id');
    expect(full!.identity.name).toBe('TradeAgent');
    const prefix = await store.resolve('ch-res');
    expect(prefix!.match).toBe('id');
    expect(prefix!.identity.id).toBe('ch-research');
  });

  it('resolve: name 大小写不敏感 (persona.name 和 channel.name 都认)', async () => {
    const byPersona = await store.resolve('researchagent');
    expect(byPersona!.match).toBe('name');
    expect(byPersona!.identity.name).toBe('ResearchAgent');
    const byChannelName = await store.resolve('meta-CHANNEL');
    expect(byChannelName!.match).toBe('name');
    expect(byChannelName!.identity.id).toBe('ch-meta');
    expect(await store.resolve('不存在')).toBeNull();
  });

  it('resolve: 优先级 number > id > name (纯数字优先走索引)', async () => {
    const r = await store.resolve('1');
    expect(r!.match).toBe('number');
    expect(r!.identity.id).toBe('ch-research');
  });

  it('setActive 持久化 + getActive 恢复 (重启后 channel 一致)', async () => {
    const active = await store.setActive('ch-trade');
    expect(active!.name).toBe('TradeAgent');
    // 模拟重启: 新实例读同一 home
    const store2 = new AgentIdentityStore(home);
    const restored = await store2.getActive();
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe('ch-trade');
    expect(restored!.name).toBe('TradeAgent');
    // 文件确实写入
    const raw = JSON.parse(await fs.readFile(activeChannelFile(home), 'utf-8'));
    expect(raw.channelId).toBe('ch-trade');
  });

  it('getActive: 无 active 记录 → 默认第一个 channel (与 Web UI 默认一致)', async () => {
    const active = await store.getActive();
    expect(active!.id).toBe('ch-research');
  });

  it('listForDisplay: 索引 + active 标记', async () => {
    await store.setActive('ch-meta');
    const list = await store.listForDisplay();
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ index: 1, active: false });
    expect(list[2]).toMatchObject({ index: 3, active: true });
  });
});
