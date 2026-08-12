// 边缘认证客户端 — 把 WebUI 登录配置托管到 Cloudflare 边缘 (Workers + KV)
// 2026-08-12: 优先请求边缘 Worker, worker 不可达时降级到本地 accounts.json fallback.
// Worker 实现见 src/web/workers/auth/.

type AccTuple = {
  provider: string;
  identifier: string;
  email: string;
  phone: string;
  username: string;
  token: string;
  ownerDid: string;
  loggedAt: string;
  skeleton: boolean;
};

export interface EdgeAuthClientOptions {
  baseUrl: string; // 边缘 Worker 根地址 (不含 /api/auth), 如 http://127.0.0.1:8788
  timeoutMs?: number;
  fallbackFile: string; // 本地 fallback 路径 ~/.bolloon/accounts.json
  log?: (msg: string) => void;
}

/**
 * 边缘认证客户端.
 * 每个 auth 操作先打边缘 Worker; 失败/超时自动降级到本地 accounts.json.
 */
export class EdgeAuthClient {
  private baseUrl: string;
  private timeoutMs: number;
  private fallbackFile: string;
  private log: (msg: string) => void;

  constructor(opts: EdgeAuthClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.fallbackFile = opts.fallbackFile;
    this.log = opts.log ?? (() => {});
  }

  // ---- 私有: 边缘 HTTP / 本地文件 ----
  private async edgeFetch(path: string, opts?: { method?: string; body?: any }): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/auth${path}`, {
        method: opts?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`边缘认证 ${path} HTTP ${res.status} ${err}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadLocal(): Promise<AccTuple[]> {
    try {
      const { readFile } = await import('fs/promises');
      const parsed = JSON.parse(await readFile(this.fallbackFile, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveLocal(accs: AccTuple[]): Promise<void> {
    const { mkdir, writeFile } = await import('fs/promises');
    const dir = this.fallbackFile.replace(/[\\/][^\\/]*$/, '');
    await mkdir(dir, { recursive: true });
    await writeFile(this.fallbackFile, JSON.stringify(accs, null, 2), { mode: 0o600 });
  }

  // ---- 公共 API (与 server.ts 原 loadAccounts/saveAccounts 语义一致) ----
  /** 返回脱敏视图 (provider/identifier/loggedAt/skeleton), 供 /api/auth/status 直接用 */
  async loadAccounts(): Promise<any[]> {
    try {
      const data = await this.edgeFetch('/status');
      return Array.isArray(data?.accounts) ? data.accounts : [];
    } catch (err: any) {
      this.log(`[edge-auth] 边缘不可达, 降级本地: ${err?.message ?? err}`);
      return this.loadLocal().then((accs) =>
        accs.map((a: AccTuple) => ({
          provider: a.provider,
          identifier: a.identifier || a.email || a.username || '',
          loggedAt: a.loggedAt,
          skeleton: !!a.skeleton,
        })));
    }
  }

  async login(payload: {
    provider: string;
    identifier?: string;
    ownerDid: string;
  }): Promise<any> {
    try {
      return await this.edgeFetch('/login', { method: 'POST', body: payload });
    } catch (err: any) {
      this.log(`[edge-auth] 登录降级本地: ${err?.message ?? err}`);
      const accs = await this.loadLocal();
      const now = new Date().toISOString();
      const exists = accs.find((a) =>
        a.provider === payload.provider &&
        (!payload.identifier || a.identifier === payload.identifier || a.email === payload.identifier));
      if (exists) {
        exists.ownerDid = payload.ownerDid;
        exists.loggedAt = now;
        exists.skeleton = true;
      } else {
        const id = payload.identifier || '';
        accs.push({
          provider: payload.provider,
          identifier: id,
          email: payload.provider === 'email' ? id : '',
          phone: payload.provider === 'phone' ? id : '',
          username: id || '',
          token: '',
          ownerDid: payload.ownerDid,
          loggedAt: now,
          skeleton: true,
        });
      }
      await this.saveLocal(accs);
      return { ok: true, provider: payload.provider, identifier: payload.identifier, ownerDid: payload.ownerDid, skeleton: true, degraded: true };
    }
  }

  async logout(payload: { provider: string }): Promise<{ ok: boolean; degraded?: boolean }> {
    try {
      return await this.edgeFetch('/logout', { method: 'POST', body: payload });
    } catch (err: any) {
      this.log(`[edge-auth] 登出降级本地: ${err?.message ?? err}`);
      const before = await this.loadLocal();
      const remaining = before.filter((a) => a.provider !== payload.provider);
      if (remaining.length === before.length) throw new Error(`未绑定 ${payload.provider} 账号`);
      await this.saveLocal(remaining);
      return { ok: true, degraded: true };
    }
  }
}