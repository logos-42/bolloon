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
    if (!this.loaded) await this.load();
    const ch = this.channels.find(c => c.id === channelId);
    if (!ch) return null;
    this.activeChannelId = channelId;
    try {
      await fs.mkdir(path.dirname(activeChannelFile(this.home)), { recursive: true });
      await fs.writeFile(activeChannelFile(this.home), JSON.stringify({ channelId, updatedAt: Date.now() }, null, 2), 'utf-8');
    } catch (e: any) {
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

// 2026-10-01 (数据事故修复): 单例**按 home 分桶**, 不再把 HOME 绑死在一个实例上。
//
// 事故经过 (真事, 用户丢了 4 个智能体): 测试 `channel-not-found.test.ts` 设了隔离 HOME
// (process.env.HOME = TMP_HOME), 但 vitest 复用 worker —— 同 worker 里**别的测试先**碰过
// getIdentityStore() ⇒ 单例已按**真实** HOME 构造 ⇒ 该测试的夹具 channel
// ("real test msg"/"test-agent") 直接写进真实的 ~/.bolloon/sessions/channels.json,
// 而且是**整表覆盖** ⇒ 用户 4 个 channel 只剩 1 条。
// 根因就是这里: `new AgentIdentityStore()` 的默认参数 `home = HOME()` 只在**构造那一刻**取值,
// 之后 process.env.HOME 再怎么变都影响不到它。
const _storesByHome = new Map<string, AgentIdentityStore>();

/** 单例 (CLI / server 共用, **按当前 HOME 分桶**; 改过 HOME 的测试会自然拿到自己的实例) */
export function getIdentityStore(): AgentIdentityStore {
  const home = HOME();
  let st = _storesByHome.get(home);
  if (!st) { st = new AgentIdentityStore(home); _storesByHome.set(home, st); }
  return st;
}

/** 仅供测试: 丢弃所有缓存实例 (改完 HOME 后强制重建) */
export function resetIdentityStoreSingletons(): void {
  _storesByHome.clear();
}

/**
 * 测试期写盘硬保护 (2026-10-01, 数据事故后的第二道闸)。
 *
 * 事故: 测试夹具把用户的真实 channels.json 整表覆盖 (4 个智能体只剩 1 条)。
 * 第一道修的是根因 (单例按 HOME 分桶); 这道是**兜底**: 只要进程带着测试标志,
 * 就**只允许**写临时目录下的数据 —— 真实 HOME (~/.bolloon) 一律拒绝并抛错。
 * 宁可让测试红, 也不能再动用户的数据。
 */
export function assertTestWriteTarget(home: string, what = '数据'): void {
  const isTest = !!process.env.VITEST || process.env.NODE_ENV === 'test';
  if (!isTest) return;
  const h = String(home || '').replace(/\/+$/, '');
  const tmpLike = h.startsWith('/tmp/') || h.startsWith('/var/folders/') || h.startsWith('/private/var/folders/') || /bolloon[-_].*test/i.test(h);
  if (!tmpLike) {
    throw new Error(
      `[test-guard] 测试进程拒绝写非临时目录的${what}: ${h} —— ` +
      `真实数据目录只能在正常 CLI/服务进程中写 (这道闸就是为防上次"夹具覆盖真实 channels.json"的事故)`,
    );
  }
}
