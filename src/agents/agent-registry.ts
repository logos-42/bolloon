/**
 * agent-registry.ts — Agent 服务注册表 (2026-08-13, Phase E1)
 *
 * Agent Economic Network 的 Discovery 层: Agent 注册服务 (定价/能力声明/钱包),
 * 其他 Agent 发现并调用.
 *
 * 存储: OrbitDB keyvalue 主存储 (去中心化, 跨设备同步) + 本地 JSON fallback.
 *   复用 task-store 模式 (getCIDDatabase.openStore).
 * 设计: registry 存整个服务列表到单键 'services' (兼容简单).
 */

import * as os from 'os';
import * as path from 'path';
import { getCIDDatabase, type CIDDatabase, type OrbitDBStore } from '../orbitdb/cid-database.js';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export const REGISTRY_ORBIT_KEY = 'services';

/** Agent 服务声明 (Agent Economic Protocol §2 Discovery) */
export interface AgentService {
  agentId: string;              // did:diap:xxx
  name: string;                 // 显示名
  wallet: string;               // 收款钱包地址
  service: {
    name: string;               // research / coding / data ...
    description: string;
    price: { amount: string; currency: string; per: string };  // {amount:"0.05", currency:"USDC", per:"query"}
  };
  capabilities?: string[];      // 能力声明
  endpoint?: string;            // 服务调用端点
  reputation?: { tasks: number; success: number; score: number };
  registeredAt?: string;
  updatedAt?: string;
}

/** OrbitDB store 名 (按 did 短名确定性) */
export function registryStoreName(did: string): string {
  const short = String(did || 'local').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40) || 'local';
  return `bolloon-agent-registry-${short}`;
}

export interface AgentRegistry {
  readonly storeName: string;
  readonly storeAddress: string;
  ready: boolean;
  /** 预热: 打开 OrbitDB keyvalue store (幂等). 失败静默 → ready=false (回退本地) */
  warm(): Promise<boolean>;
  /** 注册/更新一个 Agent 服务声明 (写 OrbitDB + 本地双写) */
  register(service: AgentService): Promise<{ ok: boolean; error?: string }>;
  /** 列出所有已注册服务 */
  list(): Promise<AgentService[]>;
  /** 按能力/名称发现服务 */
  discover(query: string): Promise<AgentService[]>;
  /** 读取本地 fallback 列表 */
  loadLocal(): Promise<AgentService[]>;
}

/** 真实实现 (OrbitDB + 本地 fallback). 单例: 共享 CID 数据库单例. */
export class OrbitDBAgentRegistry implements AgentRegistry {
  private _store: OrbitDBStore | null = null;
  ready = false;
  storeName: string;
  storeAddress = '';

  constructor(
    private did: string,
    private db: CIDDatabase = getCIDDatabase(),
    private localFile: string = path.join(home(), '.bolloon', 'agent-registry.json'),
  ) {
    this.storeName = registryStoreName(did);
  }

  async warm(): Promise<boolean> {
    if (this.ready && this._store) return true;
    try {
      this._store = await this.db.openStore(this.storeName, 'keyvalue');
      this.storeAddress = this._store.address;
      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  private async loadLocalFromDisk(): Promise<AgentService[]> {
    try {
      const { readFile } = await import('fs/promises');
      const parsed = JSON.parse(await readFile(this.localFile, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveLocalToDisk(list: AgentService[]): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('fs/promises');
      await mkdir(path.dirname(this.localFile), { recursive: true });
      await writeFile(this.localFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch { /* 本地写失败静默 */ }
  }

  async loadLocal(): Promise<AgentService[]> {
    return this.loadLocalFromDisk();
  }

  /** OrbitDB 读全部服务 (失败 → null) */
  private async orbitList(): Promise<AgentService[] | null> {
    if (!this.ready || !this._store) return null;
    try {
      const v = await this._store.get(REGISTRY_ORBIT_KEY);
      if (Array.isArray(v)) return v as AgentService[];
      return null;
    } catch {
      return null;
    }
  }

  async register(service: AgentService): Promise<{ ok: boolean; error?: string }> {
    if (!service || !service.agentId || !service.service?.name) {
      return { ok: false, error: 'agentId 和 service.name 必填' };
    }
    // 本地双写 (fallback 源)
    const local = await this.loadLocalFromDisk();
    const idx = local.findIndex((s) => s.agentId === service.agentId);
    const now = new Date().toISOString();
    const entry: AgentService = { ...service, updatedAt: now, registeredAt: service.registeredAt || now };
    if (idx >= 0) local[idx] = entry;
    else local.push(entry);
    await this.saveLocalToDisk(local);
    // OrbitDB 写穿 (尽力而为)
    if (this.ready && this._store) {
      try {
        const orbit = (await this.orbitList()) ?? [];
        const oi = orbit.findIndex((s) => s.agentId === service.agentId);
        if (oi >= 0) orbit[oi] = entry;
        else orbit.push(entry);
        await this._store.put(REGISTRY_ORBIT_KEY, orbit);
      } catch { /* orbit 写失败静默 */ }
    }
    return { ok: true };
  }

  async list(): Promise<AgentService[]> {
    // OrbitDB 优先
    const orbit = await this.orbitList();
    if (orbit !== null) return orbit;
    return this.loadLocalFromDisk();
  }

  async discover(query: string): Promise<AgentService[]> {
    const all = await this.list();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) =>
      s.service?.name?.toLowerCase().includes(q) ||
      s.service?.description?.toLowerCase().includes(q) ||
      s.name?.toLowerCase().includes(q) ||
      s.capabilities?.some((c) => c.toLowerCase().includes(q))
    );
  }
}

let _instance: AgentRegistry | null = null;
let _warmPromise: Promise<boolean> | null = null;

/** 获取 Agent Registry 单例 (首次调用 warm). */
export function getAgentRegistry(did: string = ''): AgentRegistry {
  if (!_instance) _instance = new OrbitDBAgentRegistry(did || 'local');
  return _instance;
}

/** 预热 Registry (server 启动调用). */
export function warmAgentRegistry(did: string = ''): Promise<boolean> {
  if (!_warmPromise) {
    _warmPromise = getAgentRegistry(did).warm().then((ok) => ok).catch(() => false);
  }
  return _warmPromise;
}

/** 重置单例 (测试用) */
export function resetAgentRegistry(): void {
  _instance = null;
  _warmPromise = null;
}
