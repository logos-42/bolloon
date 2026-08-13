/**
 * agent-reputation.ts — Agent 信誉系统 (2026-08-13, Phase M4)
 *
 * Agent Economic Protocol §7 Reputation: "Should I trust you?"
 * 每次服务结算后更新: tasks++ / success++ | failed++ | disputed++,
 * score = success / tasks. 存 Registry 的 service.reputation.
 *
 * 使用: provider 完成服务后调 recordOutcome(agentId, serviceName, outcome),
 *       buyer 调用前可查询 (registry 已带 reputation).
 */

import { getAgentRegistry } from './agent-registry.js';

export type ServiceOutcome = 'success' | 'failed' | 'disputed';

export interface ReputationUpdateResult {
  ok: boolean;
  error?: string;
  reputation?: { tasks: number; success: number; failed: number; disputed: number; score: number };
}

/**
 * 记录一次服务结果, 更新 provider 信誉.
 * 找不到服务 → 错误 (需先 registry_register).
 */
export async function recordServiceOutcome(
  agentId: string,
  serviceName: string,
  outcome: ServiceOutcome,
  registry?: import('./agent-registry.js').AgentRegistry,
): Promise<ReputationUpdateResult> {
  const reg = registry ?? getAgentRegistry();
  const services = await reg.list();
  const idx = services.findIndex((s) => s.agentId === agentId && s.service?.name === serviceName);
  if (idx < 0) {
    return { ok: false, error: `服务未注册: ${agentId}/${serviceName} (先 registry_register)` };
  }
  const svc = services[idx];
  const rep = svc.reputation ?? { tasks: 0, success: 0, failed: 0, disputed: 0, score: 0 };
  rep.tasks += 1;
  if (outcome === 'success') rep.success += 1;
  else if (outcome === 'failed') rep.failed += 1;
  else rep.disputed += 1;
  rep.score = rep.tasks > 0 ? Math.round((rep.success / rep.tasks) * 100) / 100 : 0;
  svc.reputation = rep;
  const r = await reg.register(svc);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, reputation: rep };
}

/** 查询 Agent 信誉 (Registry 读取) */
export async function queryReputation(agentId: string, serviceName?: string, registry?: import('./agent-registry.js').AgentRegistry): Promise<{
  ok: boolean;
  error?: string;
  entries: Array<{ service: string; reputation: { tasks: number; success: number; failed: number; disputed: number; score: number } }>;
}> {
  const reg = registry ?? getAgentRegistry();
  const services = await reg.list();
  const entries = services
    .filter((s) => s.agentId === agentId && (!serviceName || s.service?.name === serviceName))
    .map((s) => ({
      service: s.service?.name || '?',
      reputation: s.reputation ?? { tasks: 0, success: 0, failed: 0, disputed: 0, score: 0 },
    }));
  return { ok: entries.length > 0, entries, error: entries.length === 0 ? `agent ${agentId} 无服务记录` : undefined };
}

/** 格式化信誉 (agent 工具输出用) */
export function formatReputation(rep: { tasks: number; success: number; failed: number; disputed: number; score: number }): string {
  return `✅ ${rep.success} / ${rep.tasks} 任务 (score=${rep.score})${rep.failed ? `, ❌ failed=${rep.failed}` : ''}${rep.disputed ? `, ⚠️ disputed=${rep.disputed}` : ''}`;
}
