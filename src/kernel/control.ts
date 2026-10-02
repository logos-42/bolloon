/**
 * **K4: 内核控制面 (RunControl)** —— 唯一允许发起 Goal/Run 写的层。
 *
 * 为什么需要它: `AUTHORITY_DEBT` 里躺着的三条越权欠账 (`channel-must-not-write-goal` / `-run`) 都是
 * **用户发起的控制动作** (唤醒 Goal / 变更注入 / 人工批准继续), 而 channel 直接调 `goal-store` / `run-store` 的写原语。
 * 内核口径: **channel 只提交请求, 由内核执行写** —— 顺序、校验、审计都归内核一处。
 *
 * 边界 (不许破): 内核不许 import 业务模块 (见 `KERNEL_ALLOWED_IMPORT_PREFIXES`), 所以写原语一律由
 * **注入的 ports** 提供 (依赖倒置)。channel 侧只做 **wiring** (把 store 的函数绑进 ports), 不再自己调用。
 */
export type RunControlKind = 'record-recovery' | 'set-run-status' | 'wake-goal';

export const RUN_CONTROL_KINDS: readonly RunControlKind[] = ['record-recovery', 'set-run-status', 'wake-goal'];

/** 每种请求**必须**携带的定位字段 (校验用; 缺了直接拒, 不许猜) */
export const RUN_CONTROL_REQUIRED: Readonly<Record<RunControlKind, 'runId' | 'goalId'>> = {
  'record-recovery': 'runId',
  'set-run-status': 'runId',
  'wake-goal': 'goalId',
};

export interface RunControlRequest {
  kind: RunControlKind;
  /** 谁在请求 (审计): 'web' / 'cli' / 'supervisor' / 'p2p' —— 必填, 不许匿名 */
  origin: string;
  runId?: string;
  goalId?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

/** 写原语 (由调用方注入; 内核只认形状) */
export interface RunControlPorts {
  recordRecovery?(runId: string, info: Record<string, unknown>): Promise<unknown>;
  setRunStatus?(runId: string, status: string, meta?: Record<string, unknown>): Promise<unknown>;
  setContinuation?(goalId: string, patch: Record<string, unknown>): Promise<unknown>;
}

export interface RunControlOutcome {
  ok: boolean;
  kind: RunControlKind;
  via: 'kernel-control';
  /** 失败原因 (ok=false 时必有) —— 不用异常表达"拒了" */
  detail?: string;
  /** 实际派发到的 port 名 (ok=true 时必有) */
  port?: string;
}

interface AuditEntry {
  at: number;
  kind: RunControlKind;
  origin: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const audit: AuditEntry[] = [];
const AUDIT_MAX = 200;

/** 审计流水 (最近 N 条; 测试与运维可读) */
export function runControlAudit(): readonly AuditEntry[] {
  return audit;
}

export function resetRunControlAudit(): void {
  audit.length = 0;
}

/**
 * 提交一条控制请求。**唯一入口** —— 校验 (kind 合法 / 定位字段齐 / origin 非空) → 派发到 port → 记审计。
 * 一律**返回结果对象**, 不抛 (调用方不该用 try/catch 表达"请求被拒")。
 */
export async function submitRunControl(
  req: RunControlRequest,
  ports: RunControlPorts,
): Promise<RunControlOutcome> {
  const kind = req?.kind as RunControlKind;
  const finish = (ok: boolean, detail?: string, port?: string): RunControlOutcome => {
    audit.push({
      at: Date.now(),
      kind,
      origin: req?.origin ?? '(anonymous)',
      target: String(req?.runId ?? req?.goalId ?? ''),
      ok,
      detail,
    });
    if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
    return { ok, kind, via: 'kernel-control', detail, port };
  };

  if (!RUN_CONTROL_KINDS.includes(kind)) return finish(false, `未知请求类型: ${String(req?.kind)}`);
  if (!req.origin) return finish(false, '缺少 origin (审计要求: 不许匿名请求)');

  const need = RUN_CONTROL_REQUIRED[kind];
  const target = need === 'runId' ? req.runId : req.goalId;
  if (!target) return finish(false, `${kind} 缺少 ${need}`);

  if (kind === 'record-recovery') {
    if (typeof ports.recordRecovery !== 'function') return finish(false, 'port 未注入: recordRecovery');
    try {
      await ports.recordRecovery(target, req.payload ?? {});
      return finish(true, undefined, 'recordRecovery');
    } catch (err) {
      return finish(false, `recordRecovery 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (kind === 'set-run-status') {
    if (typeof ports.setRunStatus !== 'function') return finish(false, 'port 未注入: setRunStatus');
    const status = String(req.payload?.status ?? '');
    if (!status) return finish(false, 'set-run-status 缺少 payload.status');
    try {
      await ports.setRunStatus(target, status, req.payload);
      return finish(true, undefined, 'setRunStatus');
    } catch (err) {
      return finish(false, `setRunStatus 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (typeof ports.setContinuation !== 'function') return finish(false, 'port 未注入: setContinuation');
  try {
    await ports.setContinuation(target, req.payload ?? {});
    return finish(true, undefined, 'setContinuation');
  } catch (err) {
    return finish(false, `setContinuation 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }
}
