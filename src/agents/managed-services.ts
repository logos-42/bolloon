/**
 * 常驻服务注册表 (2026-10-01, 用户: 「process 也要可以管理群聊和去中心化交流进程」)。
 *
 * 背景: `process` 工具原来只管 `terminal background=true` 起的 **shell 进程** ✗,
 *   而"群聊/去中心化交流"是**常驻服务**(社交心跳 · P2P 网络 · OrbitDB 群聊存储 · 文档接收) ⇒ 看不见也管不着 ✗。
 * 做法: 一个极小的注册表 —— 每个服务提供 `status()` ✓ 和**可选**的 `start()/stop()` ✓。
 *   **如实分级**: 只有真的实现了启停的服务才允许 start/stop ✓; 其余标 `controllable:false`,
 *   控制请求会被明确拒绝并给出理由(绝不假装停掉 ✗)。
 */

export interface ManagedService {
  /** 稳定名字 (供 `process {action:'service', name}` 用) */
  name: string;
  /** 一句话用途 (给人/模型看) */
  description: string;
  /** 现在怎么样 (同步、便宜、不出网) */
  status: () => string;
  /** 不支持启停 ⇒ 控制请求会被拒(带理由) */
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export interface ServiceRow {
  name: string;
  description: string;
  status: string;
  controllable: boolean;
}

export class ManagedServices {
  private readonly services = new Map<string, ManagedService>();

  register(svc: ManagedService): void {
    if (!svc?.name) return;
    this.services.set(svc.name, svc);
  }

  list(): ServiceRow[] {
    const rows: ServiceRow[] = [];
    for (const s of this.services.values()) {
      let status = '(状态不可用)';
      try { status = String(s.status() ?? ''); } catch (e: any) { status = `(取状态失败: ${String(e?.message || e).slice(0, 60)})`; }
      rows.push({ name: s.name, description: s.description, status, controllable: !!(s.start || s.stop) });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 渲染成给模型的一行行文本 */
  describe(): string {
    const rows = this.list();
    if (!rows.length) return '(没有注册常驻服务)';
    return rows.map((r) => `- ${r.name} [${r.controllable ? '可启停' : '仅状态'}] ${r.status} — ${r.description}`).join('\n');
  }

  /**
   * 控制: op = 'start' | 'stop'. **只对实现了对应动作的服务放行** ✓。
   */
  async control(name: string, op: 'start' | 'stop'): Promise<{ ok: boolean; output: string }> {
    const s = this.services.get(String(name || '').trim());
    if (!s) return { ok: false, output: `没有这个服务: ${name}(用 process 的 action:'services' 看有哪些)` };
    const fn = op === 'start' ? s.start : s.stop;
    if (!fn) {
      return { ok: false, output: `${s.name} 不支持 ${op}(只提供状态) —— 它是随进程存在的常驻组件, 没有独立启停 ✓` };
    }
    try {
      await fn();
      let now = '';
      try { now = String(s.status() ?? ''); } catch { /* 忽略 */ }
      return { ok: true, output: `${s.name} 已${op === 'start' ? '启动' : '停止'} ✓ 现状: ${now}` };
    } catch (e: any) {
      return { ok: false, output: `${s.name} ${op} 失败: ${String(e?.message || e).slice(0, 120)}` };
    }
  }
}

/** 进程级单例 (工具上下文里传的就是它) */
export const managedServices = new ManagedServices();
