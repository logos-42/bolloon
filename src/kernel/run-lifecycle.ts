/**
 * run-lifecycle.ts — K10 ①: **运行生命周期写口** (与 `control.ts` 分开: 语义不同)
 *
 *   `control.ts`  = **命令式控制面**: 「谁命令我停 / 继续 / 恢复」—— web · cli · supervisor 发起, 带 origin 审计。
 *   本文件        = **回合事实写口**: 「我这一轮发生了什么」—— start-run · record-step · finish-run · save-checkpoint。
 *
 * 为什么必须分开 (K10 ① 的下一刀定形时复核过):
 *   混进同一个 `kind` 空间之后, K10 ②③④ 那些批次就无法区分「这条写入是外部命令还是回合事实」,
 *   两者的**失败语义也不同** —— 控制面被拒要给 409 (调用方改主意), 而事实写不进是**响亮失败**
 *   (run-store 是 strict 的: 写不进 = 这次运行在事实层面不存在, 不许静默继续)。
 *
 * 形状照抄 `control.ts` (同一个仓库里只该有一种端口写法):
 *   端口注入 · **未注入即拒** (不静默降级) · 一律**返回结果对象不抛** · 端口用 `{ok:false}` 表达拒绝要被归一化 · 审计流水可读。
 */

export type RunLifecycleOp = 'start-run' | 'record-step' | 'finish-run' | 'save-checkpoint';

export const RUN_LIFECYCLE_OPS: readonly RunLifecycleOp[] = [
  'start-run',
  'record-step',
  'finish-run',
  'save-checkpoint',
];

/** 哪些操作必须有 runId (start-run 例外: 它的 runId 是**结果**, 不是入参) */
export const RUN_LIFECYCLE_NEEDS_RUN_ID: Readonly<Record<RunLifecycleOp, boolean>> = {
  'start-run': false,
  'record-step': true,
  'finish-run': true,
  'save-checkpoint': true,
};

export interface RunLifecycleRequest {
  op: RunLifecycleOp;
  /** 谁在写 (审计): 'pi-session' / 'web' / 'supervisor' —— 必填, 不许匿名 */
  origin: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

/** 写原语 (由调用方注入; 内核只认形状) —— 对应 run-store 的 startRun/recordStep/finishRun/saveCheckpoint */
export interface RunLifecyclePorts {
  startRun?(payload: Record<string, unknown>): Promise<unknown>;
  recordStep?(runId: string, step: Record<string, unknown>): Promise<unknown>;
  finishRun?(runId: string, patch: Record<string, unknown>): Promise<unknown>;
  saveCheckpoint?(runId: string, patch: Record<string, unknown>): Promise<unknown>;
}

export interface RunLifecycleOutcome {
  ok: boolean;
  op: RunLifecycleOp;
  via: 'kernel-run-lifecycle';
  /** 失败原因 (ok=false 时必有) —— 不用异常表达"拒了" */
  detail?: string;
  /** 实际派发到的 port 名 (ok=true 时必有) */
  port?: string;
  /** 端口原样返回值 (start-run 的 `{ runId }` 就从这里取) */
  result?: unknown;
}

/**
 * 端口**不抛异常但明确拒绝** (`{ ok: false, reason }`) 的归一化 —— 与 `control.ts` 同口径。
 *   为什么必须有: store 类原语用返回值表达拒绝 (例如状态迁移不合法), 只看"有没有抛"会把**被拒当成成功**。
 */
function portRefusal(res: unknown): string | null {
  if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
    const r = res as { ok?: unknown; reason?: unknown };
    if (r.ok === false) return `端口拒绝: ${String(r.reason ?? '(未给原因)')}`;
  }
  return null;
}

interface AuditEntry {
  at: number;
  op: RunLifecycleOp;
  origin: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const audit: AuditEntry[] = [];
const AUDIT_MAX = 200;

/** 审计流水 (最近 N 条; 测试与运维可读) */
export function runLifecycleAudit(): readonly AuditEntry[] {
  return audit;
}

export function resetRunLifecycleAudit(): void {
  audit.length = 0;
}

/**
 * 提交一条生命周期写入。**唯一入口** —— 校验 (op 合法 / origin 非空 / 需要的定位字段齐) → 派发到 port → 记审计。
 * 一律**返回结果对象**, 不抛 (调用方不该用 try/catch 表达"没落盘"); 要不要把 `ok=false` 变成异常由
 * `assertLifecycleOk` 决定 —— 生命周期写入**一律**要 (见该函数注释)。
 */
export async function submitRunLifecycle(
  req: RunLifecycleRequest,
  ports: RunLifecyclePorts,
): Promise<RunLifecycleOutcome> {
  const op = req?.op as RunLifecycleOp;
  const finish = (ok: boolean, detail?: string, port?: string, result?: unknown): RunLifecycleOutcome => {
    audit.push({
      at: Date.now(),
      op,
      origin: req?.origin ?? '(anonymous)',
      target: String(req?.runId ?? '(new)'),
      ok,
      detail,
    });
    if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
    return { ok, op, via: 'kernel-run-lifecycle', detail, port, result };
  };

  if (!RUN_LIFECYCLE_OPS.includes(op)) return finish(false, `未知写入类型: ${String(req?.op)}`);
  if (!req.origin) return finish(false, '缺少 origin (审计要求: 不许匿名写入)');
  if (RUN_LIFECYCLE_NEEDS_RUN_ID[op] && !req.runId) return finish(false, `${op} 缺少 runId`);

  const payload = req.payload ?? {};

  if (op === 'start-run') {
    if (typeof ports.startRun !== 'function') return finish(false, 'port 未注入: startRun');
    try {
      const res = await ports.startRun(payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'startRun', res) : finish(true, undefined, 'startRun', res);
    } catch (err) {
      return finish(false, `startRun 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (op === 'record-step') {
    if (typeof ports.recordStep !== 'function') return finish(false, 'port 未注入: recordStep');
    try {
      const res = await ports.recordStep(req.runId as string, payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'recordStep', res) : finish(true, undefined, 'recordStep', res);
    } catch (err) {
      return finish(false, `recordStep 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (op === 'finish-run') {
    if (typeof ports.finishRun !== 'function') return finish(false, 'port 未注入: finishRun');
    try {
      const res = await ports.finishRun(req.runId as string, payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'finishRun', res) : finish(true, undefined, 'finishRun', res);
    } catch (err) {
      return finish(false, `finishRun 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  if (op === 'save-checkpoint') {
    if (typeof ports.saveCheckpoint !== 'function') return finish(false, 'port 未注入: saveCheckpoint');
    try {
      const res = await ports.saveCheckpoint(req.runId as string, payload);
      const refusal = portRefusal(res);
      return refusal ? finish(false, refusal, 'saveCheckpoint', res) : finish(true, undefined, 'saveCheckpoint', res);
    } catch (err) {
      return finish(false, `saveCheckpoint 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  return finish(false, `未处理的写入类型: ${String(op)}`);
}

/**
 * 生命周期写入**必须**落盘 —— 拿不到 `ok` 就抛。
 *
 * 依据: `run-store` 的持久化是 **strict** (写不进 = 这次运行在事实层面不存在),
 * 所以「写失败但继续跑」= 制造"agent 跑了但没记录"的老毛病。要降级只有一种合法姿势:
 * 由调用方显式换持久化等级 (环境开关), 不许在这里静默吞。
 */
export function assertLifecycleOk(out: RunLifecycleOutcome): void {
  if (!out.ok) {
    throw new Error(
      `[kernel-run-lifecycle] ${out.op} 未落盘: ${out.detail ?? '未知原因'}`
        + ' (run-store 是 strict: 写不进 = 这次运行在事实层面不存在, 不许静默继续)',
    );
  }
}
