/**
 * transport.ts — K10 ④: **通信入口端口** (与 `control.ts` / `run-lifecycle.ts` 同一套端口写法)
 *
 * 目标形态 (设计页): `transport → router → channel mailbox` —— 也就是说:
 *   **上层只对"通信端口"说话, 不直接对某条传输 (hyperswarm / iroh / p2pNetwork) 说话**。
 *   Pi 现在自己持有 3 个薄包装 (`getPeers` / `sendMessage` / `broadcast` → `p2pNetwork`),
 *   那正是"Pi 内部通信发送逻辑"还没迁完的形状 (K10 ④)。
 *
 * 为什么用端口而不是直接调传输:
 *   - 传输是可替换的 (hyperswarm / iroh / 以后的东西) ⇒ 上层不该 import 具体实现;
 *   - 发送是**有副作用**的动作 ⇒ 要能审计 (谁发的 / 发给谁 / 成没成), 且**未注入即拒** (不静默丢弃消息);
 *   - 与 `control.ts` / `run-lifecycle.ts` 保持同一种形状, 免得仓里出现第三种端口写法。
 *
 * 注: 本模块只做"入口收口", **不搬传输实现** (传输仍在 `src/network/**`); 判据见 `src/test/k10-transport-port.test.ts`。
 */

export type TransportOp = 'send' | 'broadcast' | 'peers';

export const TRANSPORT_OPS: readonly TransportOp[] = ['send', 'broadcast', 'peers'];

/** 哪些操作必须有目标 (send 要 peerId; broadcast / peers 不需要) */
export const TRANSPORT_NEEDS_TARGET: Readonly<Record<TransportOp, boolean>> = {
  send: true,
  broadcast: false,
  peers: false,
};

export interface TransportRequest {
  op: TransportOp;
  /** 谁在发 (审计): 'pi-session' / 'web' / 'supervisor' / 'cron' —— 必填, 不许匿名 */
  origin: string;
  /** send 的目标 peerId */
  peerId?: string;
  /** 消息类型 (默认 'message') */
  kind?: string;
  payload?: string;
}

/** 写/读原语 (由调用方注入; 内核只认形状) */
export interface TransportPorts {
  send?(peerId: string, kind: string, payload: string): Promise<unknown>;
  broadcast?(kind: string, payload: string): Promise<unknown>;
  peers?(): string[] | Promise<string[]>;
  /**
   * **同步**读对端 —— 给调用方是同步签名的地方用 (`getPeers()` / `listPeers()` 在 Pi 上是同步的,
   * 改成 async 会波及调用方) ⇒ 不硬塞进 async 的 `submitTransport`, 单独一个同步入口。
   * 未注入 ⇒ 返回 `null` (调用方自己决定是空列表还是原样降级), 与 async 路径的"未注入即拒"呼应。
   */
  peersSync?(): string[];
}

/**
 * 同步读对端 (K10 ④ 后半) —— 与 `submitTransport` 分开是因为**签名**而不是因为语义:
 *   传输层是异步的, 但上层有同步调用点 (sync 签名不能凭空变 async)。
 *   返回 `null` = 端口未注入 (调用方必须自己决定降级, 不许假装"没有对端" —— 那是两回事)。
 */
export function transportPeersSync(ports: TransportPorts): string[] | null {
  if (typeof ports?.peersSync !== 'function') return null;
  return ports.peersSync();
}

export interface TransportOutcome {
  ok: boolean;
  op: TransportOp;
  via: 'kernel-transport';
  detail?: string;
  port?: string;
  /** 端口原样返回值 (peers 的列表从这里取) */
  result?: unknown;
}

/** 端口用 `{ok:false}` 表达拒绝的归一化 (与另外两个端口同口径) */
function portRefusal(res: unknown): string | null {
  if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
    const r = res as { ok?: unknown; reason?: unknown };
    if (r.ok === false) return `端口拒绝: ${String(r.reason ?? '(未给原因)')}`;
  }
  return null;
}

interface AuditEntry {
  at: number;
  op: TransportOp;
  origin: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const audit: AuditEntry[] = [];
const AUDIT_MAX = 200;

/** 审计流水 (最近 N 条; 测试与运维可读) */
export function transportAudit(): readonly AuditEntry[] {
  return audit;
}

export function resetTransportAudit(): void {
  audit.length = 0;
}

/** 提交一次通信动作。**唯一入口** —— 校验 → 派发到 port → 记审计; 一律返回结果对象, 不抛。 */
export async function submitTransport(
  req: TransportRequest,
  ports: TransportPorts,
): Promise<TransportOutcome> {
  const op = req?.op as TransportOp;
  const finish = (ok: boolean, detail?: string, port?: string, result?: unknown): TransportOutcome => {
    audit.push({
      at: Date.now(),
      op,
      origin: req?.origin ?? '(anonymous)',
      target: String(req?.peerId ?? '(all)'),
      ok,
      detail,
    });
    if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
    return { ok, op, via: 'kernel-transport', detail, port, result };
  };

  if (!TRANSPORT_OPS.includes(op)) return finish(false, `未知通信动作: ${String(req?.op)}`);
  if (!req.origin) return finish(false, '缺少 origin (审计要求: 不许匿名发送)');
  if (TRANSPORT_NEEDS_TARGET[op] && !req.peerId) return finish(false, `${op} 缺少 peerId`);

  const kind = req.kind ?? 'message';
  const payload = req.payload ?? '';

  if (op === 'send') {
    if (typeof ports.send !== 'function') return finish(false, 'port 未注入: send');
    try {
      const res = await ports.send(req.peerId as string, kind, payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'send', res) : finish(true, undefined, 'send', res);
    } catch (err) {
      return finish(false, `send 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (op === 'broadcast') {
    if (typeof ports.broadcast !== 'function') return finish(false, 'port 未注入: broadcast');
    try {
      const res = await ports.broadcast(kind, payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'broadcast', res) : finish(true, undefined, 'broadcast', res);
    } catch (err) {
      return finish(false, `broadcast 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (op === 'peers') {
    if (typeof ports.peers !== 'function') return finish(false, 'port 未注入: peers');
    try {
      const res = await ports.peers();
      return finish(true, undefined, 'peers', res);
    } catch (err) {
      return finish(false, `peers 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  return finish(false, `未处理的通信动作: ${String(op)}`);
}
