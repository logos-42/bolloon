import { shellExec } from './shell-tool.js';
import { getBranchPrefix, getCooldownMs } from './shell-guard.js';

/**
 * Session factory + runSelfImproveLoop.
 *
 * 从 pi-sdk.ts 抽出 (2026-07-06):
 *   - createAgentSession(config, forceNew?)
 *   - getAgentSession()
 *   - resetAgentSession()
 *   - runSelfImproveLoop(goal)
 *
 * 三个状态变量 (module-level):
 *   - sessionInstance: 单例 cache
 *   - lastIdentityDid: DID 变化检测
 *   - independentSessions: 多 session 缓存 (peerId 含 : 的场景)
 *   - lastSelfImproveAt: 自改冷却期
 */

import { PiAgentSession } from './pi-sdk.js';
import type { AgentSession, AgentSessionConfig } from './pi-sdk-types.js';

let sessionInstance: AgentSession | null = null;
let lastIdentityDid: string | null = null;

const independentSessions: Map<string, AgentSession> = new Map();

export async function createAgentSession(config: AgentSessionConfig, forceNew?: boolean): Promise<AgentSession> {
  const incomingDid = config.identityDoc?.did;

  if (config.peerId && config.peerId.includes(':')) {
    const key = config.peerId;
    if (!forceNew && independentSessions.has(key)) {
      console.log(`[createAgentSession] 找到现有独立 session, key=${key}`);
      const existing = independentSessions.get(key)!;
      await existing.whenReady();
      return existing;
    }
    const session = new PiAgentSession(config);
    independentSessions.set(key, session);
    console.log(`[createAgentSession] 创建独立 session, key=${key}, DID=${incomingDid}`);
    await session.whenReady();
    return session;
  }

  if (forceNew) {
    const key = `force:${Date.now()}`;
    const session = new PiAgentSession(config);
    independentSessions.set(key, session);
    console.log(`[createAgentSession] 创建强制新 session, key=${key}`);
    await session.whenReady();
    return session;
  }

  if (sessionInstance && lastIdentityDid && incomingDid && lastIdentityDid !== incomingDid) {
    console.log(`[createAgentSession] DID 变化 ${lastIdentityDid} -> ${incomingDid}，重建 session`);
    sessionInstance = null;
  }

  if (sessionInstance) {
    const currentDid = sessionInstance.getIdentity().did;
    if (incomingDid && currentDid !== incomingDid) {
      console.log(`[createAgentSession] 更新 identity: ${currentDid} -> ${incomingDid}`);
      sessionInstance.updateIdentity({
        did: incomingDid,
        name: config.identityDoc?.name || sessionInstance.getIdentity().name,
        publicKey: config.identityDoc?.publicKey || '',
        createdAt: Date.now()
      });
    }
    await sessionInstance.whenReady();
    return sessionInstance;
  }

  const newSession = new PiAgentSession(config);
  sessionInstance = newSession;
  lastIdentityDid = config.identityDoc?.did || null;
  console.log(`[createAgentSession] 新建 session, DID=${lastIdentityDid}`);
  await newSession.whenReady();
  return newSession;
}

export function getAgentSession(): AgentSession | null {
  return sessionInstance;
}

export function resetAgentSession(): void {
  sessionInstance = null;
  lastIdentityDid = null;
}

/**
 * 自我改进循环: 在沙箱分支上工作, 输出结果给用户审.
 *
 * 不在 PiAgent 实例上的原因: 心跳回调可能没有 agent 实例, 单独函数更易复用.
 *
 * **关键不变量**:
 *   1. AI 不能 push 到 master (shell-guard 黑名单 + git 受保护分支)
 *   2. 改动必须走沙箱分支 (SELF_IMPROVE_BRANCH_PREFIX)
 *   3. 6 小时冷却期 (SELF_IMPROVE_COOLDOWN_MS)
 *   4. 写文件必须经过 shell_exec + 护栏检查
 */
let lastSelfImproveAt: number | null = null;

export async function runSelfImproveLoop(goal: string): Promise<{ success: boolean; output?: string; error?: string }> {
  const cooldownMs = getCooldownMs();
  if (lastSelfImproveAt && Date.now() - lastSelfImproveAt < cooldownMs) {
    const waitHrs = Math.ceil((cooldownMs - (Date.now() - lastSelfImproveAt)) / 3600000);
    return { success: false, error: `自改冷却中, 还需要约 ${waitHrs} 小时` };
  }

  const sourceBranch = 'master';
  const newBranch = `${getBranchPrefix()}${Date.now()}`;

  console.log(`[self-improve] 启动自改循环, 目标: ${goal}, 新分支: ${newBranch}`);

  const r1 = await shellExec('git', ['checkout', sourceBranch]);
  if (!r1.success) return { success: false, error: `切换到 ${sourceBranch} 失败: ${r1.error}` };

  const r2 = await shellExec('git', ['checkout', '-b', newBranch]);
  if (!r2.success) return { success: false, error: `创建分支失败: ${r2.error}` };

  lastSelfImproveAt = Date.now();
  return {
    success: true,
    output: `✅ 自改分支已创建: ${newBranch}\n目标: ${goal}\n\n**护栏已激活**:\n  - 仅允许白名单命令\n  - 6 小时冷却期\n\nAI 接下来会用 shell_exec 工具改源码. 完成后你会在对话里看到 diff 摘要, 手动 git diff master..${newBranch} 审, 满意再 merge.`
  };
}
