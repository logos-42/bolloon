/**
 * run-resume.ts — K10 余项: **从 checkpoint 恢复一次运行的编排与政策** (从 pi-sdk 的方法体搬进内核)
 *
 * 搬走的是**序列与政策** (不是 I/O):
 *   ① 恢复前**反查模型配置**: Run 记录里的 `modelConfig` 快照不能只写不核 —— "快照记 A, 现在盘上生效 B"
 *      这种漂移若被静默继续, 长任务的历史执行链就说不清了;
 *   ② 漂移的**上报口径**: 漂了 ⇒ warn (说清哪几个字段) · 一致 ⇒ info 一句明确结论 · **核对失败不阻塞恢复**;
 *   ③ **按 Run 快照装配运行时的判据** (`decideResumeReinstall`, 见 `run-lifecycle.ts`):
 *      只在"漂了"或"核对不了"时装 —— 一致时运行时本来就是对的, 重装是白跑一趟; **装配失败也不阻塞恢复**;
 *   ④ 准备失败 ⇒ 直接把 `plan` 交回 (不驱动);恢复态的**单次语义**: 驱动前后由端口负责设置/清除 (finally 保证清)。
 *
 * I/O 全部端口注入 (核对 / 准备 / 装配 / 落态 / 驱动 / 清态 / 日志)。本模块不 import 任何 agent 侧模块。
 */

import { decideResumeReinstall } from './run-lifecycle.js';

export interface ResumeDrift {
  drifted?: boolean;
  verified?: boolean;
  message?: string;
  snapshot?: unknown;
}

export interface ResumePlanLike {
  goalId?: string;
  [k: string]: unknown;
}

export interface ResumePorts {
  /** 反查 Run 快照 vs 现状 (失败/拿不到 ⇒ 返回 null/undefined, **不阻塞恢复**) */
  detectDrift(runId: string): Promise<ResumeDrift | null | undefined>;
  /** 校验状态 + 读 checkpoint + 记 recovery + 落 recovering */
  prepareResume(runId: string): Promise<{ ok: boolean; reason?: string; plan?: ResumePlanLike }>;
  /** 按 Run 快照装配运行时 (唯一实现: 内核不自己 init 任何东西) */
  applySnapshot(snapshot: unknown): Promise<{ provider?: string; model?: string; configHash?: unknown }>;
  /** 把恢复计划落到会话状态 (resume 态 / goalBinding) —— 落在哪由注入方决定 */
  applyPlan(plan: ResumePlanLike): void;
  /** 驱动同一个 runId 继续 (跑一轮) —— 计划怎么变成指令由注入方决定 */
  continueRun(plan: ResumePlanLike): Promise<string>;
  /** 清除恢复态 (单次语义; 一定被调用, 即使在驱动里抛错) */
  clearPlan(): void;
  /** 上报 (正文由内核给, 前缀/去处由注入方决定) */
  log?: (level: 'warn' | 'info', body: string) => void;
}

export interface ResumeOutcome {
  ok: boolean;
  reason?: string;
  reply?: string;
  modelDrift?: ResumeDrift;
  modelApplied?: { provider?: string; model?: string; configHash?: unknown };
}

/**
 * 恢复一次运行 —— **唯一入口**。语义与迁移前逐条一致 (见文件头 ①②③④); **本函数只在驱动阶段可能抛**
 *   (与迁移前一致: `prompt` 抛错会冒出去, 但恢复态**一定**被清), 其余每一步失败都**不阻塞恢复**。
 */
export async function resumeRunViaKernel(runId: string, ports: ResumePorts): Promise<ResumeOutcome> {
  let modelDrift: ResumeDrift | undefined;
  let modelApplied: ResumeOutcome['modelApplied'];

  try {
    modelDrift = (await ports.detectDrift(runId)) || undefined;
    if (modelDrift?.drifted) {
      ports.log?.('warn', `恢复时模型配置已偏离 Run 快照: ${String(modelDrift.message ?? '')}`);
    } else if (modelDrift) {
      ports.log?.('info', `恢复前核对: ${String(modelDrift.message ?? '')}`);
    }
  } catch {
    /* 核对本身失败不阻塞恢复 (与迁移前一致) */
  }

  const prep = await ports.prepareResume(runId);
  if (!prep?.ok || !prep.plan) {
    return { ok: false, reason: prep?.reason, ...(modelDrift ? { modelDrift } : {}) };
  }

  if (modelDrift && decideResumeReinstall(modelDrift)) {
    try {
      modelApplied = await ports.applySnapshot(modelDrift.snapshot);
      ports.log?.(
        'info',
        `已按 Run 快照装配运行时: ${String(modelApplied?.provider ?? '')}/${String(modelApplied?.model ?? '')}` +
          ` (configHash ${String(modelApplied?.configHash ?? '').slice(0, 12)})`,
      );
    } catch (e) {
      // 装配失败不阻塞恢复 (如实说; 调用方可以从返回值里看出没装成)
      ports.log?.('warn', `按 Run 快照装配运行时失败, 保持当前运行时: ${String((e as Error)?.message || e).slice(0, 160)}`);
      modelApplied = undefined;
    }
  }

  ports.applyPlan(prep.plan);
  try {
    const reply = await ports.continueRun(prep.plan);
    return { ok: true, reply, ...(modelDrift ? { modelDrift } : {}), ...(modelApplied ? { modelApplied } : {}) };
  } finally {
    ports.clearPlan();
  }
}
