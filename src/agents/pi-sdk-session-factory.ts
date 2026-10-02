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
import { getOrCreateActor } from '../kernel/channel-actor.js';
import type { AgentSession, AgentSessionConfig } from './pi-sdk-types.js';

/**
 * **K5 第 3 步**: 会话创建时绑定它所属 channel 的 Actor —— 只做**归属**。
 *   · **注册键取会话身份** (`loadSessionKey` 优先, 否则整条 `peerId`); `channelId` 另取 `peerId` 的 `:` 前段;
 *   · 没有身份 ⇒ **不绑定** (不许有 default 兜底桶);
 *   · 状态 (messageHistory / channelId / agentId / goalId) **仍在 Pi 实例字段上**, 逐项迁入见 8 步台账;
 *   · 绑定是**幂等**的: 同一 channelId 永远拿到同一个 actor (`getOrCreateActor`)。
 */
function attachActor(session: AgentSession, config: AgentSessionConfig): AgentSession {
  // **注册键 = 会话身份** (SessionStore key 优先, 否则整条 peerId)。
  //   不许取 `:` 前段: 同一 channel 下不同会话会落进同一个桶 ⇒ history 串台
  //   (2026-10-02 全量回归实证: 5 红)。
  const identity = String(config.loadSessionKey || config.peerId || '');
  // **没有身份就不归属** —— 没有 'default' 兜底桶, 宁可不共享也不许串台。
  if (!identity) return session;
  // 只预置 agentId (它是构造入参, 本来就属于会话); **channelId 不预置** —— 等 prompt/入口设置
  const actor = getOrCreateActor(identity, { agentId: config.agentId || '' });
  if (typeof session.attachActor === 'function') session.attachActor(actor);
  else session.actor = actor;
  return session;
}

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
    const session = attachActor(new PiAgentSession(config), config);
    independentSessions.set(key, session);
    console.log(`[createAgentSession] 创建独立 session, key=${key}, DID=${incomingDid}`);
    await session.whenReady();
    return session;
  }

  if (forceNew) {
    const key = `force:${Date.now()}`;
    const session = attachActor(new PiAgentSession(config), config);
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

  const newSession = attachActor(new PiAgentSession(config), config);
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
