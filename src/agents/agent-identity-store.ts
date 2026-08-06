/**
 * agent-identity-store.ts — 统一 Agent Identity 源 (2026-08-06)
 *
 * 解决 CLI 状态栏与 Web UI 智能体名称不一致的根因:
 * 多个地方各自维护 agent 名称 → 统一从这里读。
 *
 * 数据流:
 *   channels.json (唯一数据源)
 *        │
 *   AgentIdentityStore (读取 + active 持久化)
 *        │
 *   CLI 状态栏 / /channel 命令  ──  Web UI (GET /active-channel + /channels)
 *
 * active channel 持久化: ~/.bolloon/active-channel.json (CLI 与 Web 共用,
 * 重启后自动恢复上次 channel / identity)。
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface AgentIdentity {
  /** channel id (channels.json 的 id) */
  id: string;
  /** 显示名: persona.name 优先, fallback channel.name */
  name: string;
  channelId?: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
}

export interface IdentityChannel {
  id: string;
  name: string;
  agentId: string;
  did?: string;
  persona?: { name?: string; description?: string; personality?: string; greeting?: string; capabilities?: string[]; interests?: string[] };
  publicKey?: string;
  cid?: string;
  ipnsName?: string;
}

export type ResolveMatch = 'name' | 'id' | 'number';

export interface ResolveResult {
  identity: AgentIdentity;
  channel: IdentityChannel;
  match: ResolveMatch;
  index: number; // 1-based
}

const HOME = (): string => process.env.HOME || '/tmp';

/** channels.json 路径 (与 server-types.ts CHANNELS_PATH 对齐) */
export function channelsPaths(home: string = HOME()): string[] {
  return [
    path.join(home, '.bolloon', 'sessions', 'channels.json'),
    path.join(home, '.bolloon', 'channels.json'),
  ];
}

export function activeChannelFile(home: string = HOME()): string {
  return path.join(home, '.bolloon', 'active-channel.json');
}

export class AgentIdentityStore {
  private channels: IdentityChannel[] = [];
  private activeChannelId: string | null = null;
  private loaded = false;

  constructor(private home: string = HOME()) {}

  /** 读 channels.json + active-channel.json (幂等, 可重复调) */
  async load(): Promise<void> {
    for (const p of channelsPaths(this.home)) {
      try {
        const raw = JSON.parse(await fs.readFile(p, 'utf-8'));
        if (Array.isArray(raw)) { this.channels = raw as IdentityChannel[]; break; }
      } catch { /* 该路径不存在则试下一个 */ }
    }
    try {
      const a = JSON.parse(await fs.readFile(activeChannelFile(this.home), 'utf-8'));
      if (a && typeof a.channelId === 'string') this.activeChannelId = a.channelId;
    } catch { /* 无 active 记录 */ }
    this.loaded = true;
  }

  get isLoaded(): boolean { return this.loaded; }

  get rawChannels(): IdentityChannel[] { return this.channels; }

  /** channel → AgentIdentity (persona.name 优先) */
  private toIdentity(c: IdentityChannel): AgentIdentity {
    const name = c.persona?.name?.trim() || c.name || c.agentId || 'agent';
    return {
      id: c.id,
      name,
      channelId: c.id,
      avatar: c.persona?.name ? undefined : undefined,
      metadata: {
        agentId: c.agentId,
        did: c.did,
        persona: c.persona,
        publicKey: c.publicKey,
        cid: c.cid,
        ipnsName: c.ipnsName,
      },
    };
  }

  /** 全部智能体身份 (channel 顺序 = 索引顺序, 1-based) */
  getIdentities(): AgentIdentity[] {
    return this.channels.map(c => this.toIdentity(c));
  }

  /**
   * 解析 /channel <query>:
   *   纯数字 → number (1-based 索引)
   *   匹配 id → id (完整或前缀)
   *   匹配 name → name (大小写不敏感)
   * 优先级: number > id > name
   */
  async resolve(query: string): Promise<ResolveResult | null> {
    if (!this.loaded) await this.load();
    const q = String(query || '').trim();
    if (!q) return null;

    // 1. number: 纯数字 → 1-based 索引
    if (/^\d+$/.test(q)) {
      const idx = parseInt(q, 10);
      const ch = this.channels[idx - 1];
      if (ch) return { identity: this.toIdentity(ch), channel: ch, match: 'number', index: idx };
    }

    // 2. id: 完整或前缀
    let found = this.channels.find(c => c.id === q);
    if (found) {
      const idx = this.channels.indexOf(found) + 1;
      return { identity: this.toIdentity(found), channel: found, match: 'id', index: idx };
    }
    found = this.channels.find(c => c.id.startsWith(q));
    if (found) {
      const idx = this.channels.indexOf(found) + 1;
      return { identity: this.toIdentity(found), channel: found, match: 'id', index: idx };
    }

    // 3. name: persona.name / channel.name 大小写不敏感 (含子串)
    const ql = q.toLowerCase();
    found = this.channels.find(c => {
      const names = [c.persona?.name, c.name].filter(Boolean).map(n => String(n).toLowerCase());
      return names.some(n => n === ql || n.includes(ql));
    });
    if (found) {
      const idx = this.channels.indexOf(found) + 1;
      return { identity: this.toIdentity(found), channel: found, match: 'name', index: idx };
    }

    return null;
  }

  /** 当前 active 身份 (无 active 或找不到时 → 第一个 channel, 与 Web UI 默认一致) */
  async getActive(): Promise<AgentIdentity | null> {
    if (!this.loaded) await this.load();
    if (this.activeChannelId) {
      const ch = this.channels.find(c => c.id === this.activeChannelId);
      if (ch) return this.toIdentity(ch);
    }
    return this.channels.length > 0 ? this.toIdentity(this.channels[0]) : null;
  }

  /** 切换 active channel + 持久化 (CLI /channel 与 Web POST /active-channel 共用) */
  async setActive(channelId: string): Promise<AgentIdentity | null> {
    process.stderr.write(`\n[DBG-SETACTIVE] called channelId=${channelId}\n`);
    if (!this.loaded) await this.load();
    const ch = this.channels.find(c => c.id === channelId);
    if (!ch) return null;
    this.activeChannelId = channelId;
    try {
      await fs.mkdir(path.dirname(activeChannelFile(this.home)), { recursive: true });
      await fs.writeFile(activeChannelFile(this.home), JSON.stringify({ channelId, updatedAt: Date.now() }, null, 2), 'utf-8');
    } catch (e: any) {
      process.stderr.write(`\n[DBG-SETACTIVE] 写文件失败: ${e?.message}\n`);
      console.warn(`[identity-store] 持久化 active channel 失败 (非致命): ${e?.message}`);
    }
    return this.toIdentity(ch);
  }

  /** 列出所有 channel 供 /channel 无参显示 */
  async listForDisplay(): Promise<{ index: number; identity: AgentIdentity; active: boolean }[]> {
    if (!this.loaded) await this.load();
    const active = this.activeChannelId;
    return this.channels.map((c, i) => ({
      index: i + 1,
      identity: this.toIdentity(c),
      active: c.id === active,
    }));
  }
}

let _store: AgentIdentityStore | null = null;
/** 单例 (CLI / server 共用; 测试可 new AgentIdentityStore(tmpHome)) */
export function getIdentityStore(): AgentIdentityStore {
  if (!_store) _store = new AgentIdentityStore();
  return _store;
}
