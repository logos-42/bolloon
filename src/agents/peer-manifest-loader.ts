/**
 * peer-manifest-loader.ts — 智能体相互了解的懒加载触发器
 *
 * 设计目的 (2026-07-05):
 *   远程 P2P 节点的 manifest 不默认进 LLM prompt, 只在需要时拉取.
 *   3 个触发点:
 *     ① @-mention 远端 channel    → 立即拉对方 manifest + 对应 agent 详细描述
 *     ② 本地 agent 连续失败       → 兜底拉对方 manifest (对方可能有解)
 *     ③ 关键词触发                → 用户说 "持续协助" / "cooperate" 时加载
 *
 *   加载结果拼成 prompt 附加块 (≤2000 字符), 拼到 system prompt 尾部.
 *   不入持久化 prompt, 不污染主对话.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as peerFs from '../network/peer-fs.js';

// ============== 类型 ==============

export interface TriggerContext {
  /** 当前 channel id (用于拼资源) */
  channelId?: string;
  channelName?: string;
  /** 触发原因 */
  reason: 'mention-remote' | 'consecutive-failure' | 'cooperate-keyword' | 'manual';
  /** 触发信号原文 (mention 名 / 失败原因 / 关键词) */
  triggerValue: string;
  /** 涉及的远端 peer publicKey (单个) */
  remotePublicKey: string;
}

export interface LoadResult {
  publicKey: string;
  /** capability-index.md 全文 (≤500 字) */
  capabilityIndex: string;
  /** 拼好的 prompt 附加块 (≤2000 字) */
  promptBlock: string;
  /** 涉及到的 agent 详细描述 (按需拉取) */
  agentDescriptions: Array<{ agentId: string; body: string }>;
  /** 加载是否触发 RPC (true = 真发了 RPC, false = 用本地缓存) */
  rpcTriggered: boolean;
  /** 加载耗时 ms */
  durationMs: number;
}

// ============== 主入口 ==============

/**
 * 加载对方的 manifest + (可选) 详细 agent 描述, 拼成 prompt 块.
 * 行为:
 *   1) 先看本地 ~/.bolloon/peers/<pk>/capability-index.md 缓存 — 命中且新 (≤1h) → 直接用
 *   2) 否则调 RPC 拉 manifest → 落盘 → 读 capability-index.md
 *   3) 如果 triggerValue 是 agent id 或 capability 名, 再发 RPC 拉详细描述
 */
export async function loadPeerManifest(
  ctx: TriggerContext,
  opts: {
    /** P2PDirect 实例 (发 RPC 用) */
    p2p: { sendToWithWait(pk: string, data: string, timeout?: number): Promise<'SENT' | 'NO_CONN' | 'WRITE_FAIL'>, getPublicKey(): string };
    /** 缓存有效期 ms (默认 1 小时) */
    cacheTtlMs?: number;
  }
): Promise<LoadResult | null> {
  const t0 = Date.now();
  const pk = ctx.remotePublicKey;
  if (!pk || pk === opts.p2p.getPublicKey()) return null; // 自己

  let rpcTriggered = false;
  let idx = await peerFs.readPeerIndex(pk);
  let capabilityIndex = await peerFs.readCapabilityIndex(pk);

  // 缓存判断: capability-index 存在 + 索引在 TTL 内 → 跳过 RPC
  const ttl = opts.cacheTtlMs ?? 60 * 60 * 1000;
  if (!idx || !capabilityIndex || (idx.updatedAt && (Date.now() - new Date(idx.updatedAt).getTime()) > ttl)) {
    // 缓存过期或不完整, 发 RPC 拉新
    const since = idx?.manifestTs || 0;
    const req = JSON.stringify({
      v: 3, op: 'agent.manifest.exchange',
      payload: { since, fromPublicKey: opts.p2p.getPublicKey() }
    });
    const r = await opts.p2p.sendToWithWait(pk, req, 3000);
    if (r === 'SENT') {
      rpcTriggered = true;
      // 等异步处理落盘 — 这里 sleep 短时间, 不阻塞主线程太久
      await new Promise(r => setTimeout(r, 500));
      idx = await peerFs.readPeerIndex(pk);
      capabilityIndex = await peerFs.readCapabilityIndex(pk);
    }
  }

  if (!idx) {
    return {
      publicKey: pk,
      capabilityIndex: '',
      promptBlock: `[远端 peer ${pk.slice(0, 12)}…] 暂无 manifest 缓存 (对方未响应或本地首次连接).`,
      agentDescriptions: [],
      rpcTriggered,
      durationMs: Date.now() - t0,
    };
  }

  // 按 triggerValue 决定要不要拉详细 agent 描述
  const agentDescriptions: Array<{ agentId: string; body: string }> = [];
  const lowerVal = ctx.triggerValue.toLowerCase();

  // 1) 如果 triggerValue 看起来是 agent id (有特殊前缀/格式) → 直接拉
  // 2) 如果是 capability 名 (编程/翻译/...) → 在 idx 里找匹配 capability 的 agent → 拉
  const candidates: string[] = [];
  if (ctx.triggerValue.match(/^(agent_|agt_|bot_|assist_|task_)/)) {
    candidates.push(ctx.triggerValue);
  } else {
    for (const a of idx.agents) {
      if (a.capabilities.some(c => c.toLowerCase().includes(lowerVal))) {
        candidates.push(a.id);
      }
    }
  }

  // 拉详细描述 (限 3 个, 避免 prompt 爆炸)
  for (const agentId of candidates.slice(0, 3)) {
    const localFile = peerFs.getPeerAgentMdPath(pk, agentId);
    let body = '';
    try {
      body = await fs.readFile(localFile, 'utf-8');
    } catch {}
    if (!body) {
      // 本地没缓存, 拉 RPC
      const req = JSON.stringify({
        v: 3, op: 'agent.resource.get',
        payload: { agentId, fromPublicKey: opts.p2p.getPublicKey() }
      });
      const r = await opts.p2p.sendToWithWait(pk, req, 3000);
      if (r === 'SENT') {
        rpcTriggered = true;
        // 异步处理, 等 300ms
        await new Promise(r => setTimeout(r, 300));
        try { body = await fs.readFile(localFile, 'utf-8'); } catch {}
      }
    }
    if (body) agentDescriptions.push({ agentId, body: body.slice(0, 1500) });
  }

  // 拼 prompt 附加块
  const block = buildPromptBlock(ctx, capabilityIndex || '(无索引)', agentDescriptions, idx);

  return {
    publicKey: pk,
    capabilityIndex: capabilityIndex || '',
    promptBlock: block,
    agentDescriptions,
    rpcTriggered,
    durationMs: Date.now() - t0,
  };
}

/**
 * 把加载结果拼成可注入 system prompt 的文本块 (≤2000 字)
 */
function buildPromptBlock(
  ctx: TriggerContext,
  capabilityIndex: string,
  agentDescriptions: Array<{ agentId: string; body: string }>,
  idx: peerFs.PeerIndexFile
): string {
  const lines: string[] = [];
  lines.push(`[远端 peer 临时上下文] ${ctx.reason} → ${ctx.triggerValue}`);
  lines.push(`远端节点: ${idx.ownerName || idx.publicKey.slice(0, 12)}… (${idx.agents.length} agents)`);
  lines.push('');
  lines.push('## 对方能力索引');
  lines.push(capabilityIndex);
  lines.push('');
  if (agentDescriptions.length > 0) {
    lines.push('## 触发相关的 agent 详细描述');
    for (const a of agentDescriptions) {
      lines.push(`### ${a.agentId}`);
      lines.push(a.body);
      lines.push('');
    }
  }
  const text = lines.join('\n').trim();
  return text.length > 2000 ? text.slice(0, 1997) + '…' : text;
}

// ============== 触发检测器 ==============

export interface DetectionResult {
  shouldLoad: boolean;
  reason?: TriggerContext['reason'];
  remotePublicKey?: string;
  triggerValue?: string;
}

/**
 * 检测 /message 处理后是否需要加载远端 peer manifest.
 * 输入:
 *   - text (用户原始输入)
 *   - channelId (当前 channel)
 *   - remoteChannels (远端 channel 列表 [{ id, name, _ownerPublicKey }])
 *   - consecutiveFailures (连续 LLM 失败次数, 可选)
 */
export function detectLoadTrigger(opts: {
  text: string;
  channelId?: string;
  remoteChannels: Array<{ id: string; name: string; _ownerPublicKey?: string }>;
  consecutiveFailures?: number;
}): DetectionResult {
  // 触发 ①: @-mention 远端 channel
  const mentionRe = /@([一-龥A-Za-z0-9_\-]{1,30})/g;
  for (const m of opts.text.matchAll(mentionRe)) {
    const name = m[1];
    const rc = opts.remoteChannels.find(c => c.name === name);
    if (rc && rc._ownerPublicKey) {
      return {
        shouldLoad: true,
        reason: 'mention-remote',
        remotePublicKey: rc._ownerPublicKey,
        triggerValue: name,
      };
    }
  }

  // 触发 ③: 关键词
  const text = opts.text.toLowerCase();
  const keywords = ['持续协助', '一起合作', 'cooperate', '协作', '对方能干', 'remote help', 'find peer'];
  for (const k of keywords) {
    if (text.includes(k.toLowerCase())) {
      // 关键词触发 — 用第一个 known remote channel 的 owner
      if (opts.remoteChannels.length > 0 && opts.remoteChannels[0]._ownerPublicKey) {
        return {
          shouldLoad: true,
          reason: 'cooperate-keyword',
          remotePublicKey: opts.remoteChannels[0]._ownerPublicKey,
          triggerValue: k,
        };
      }
    }
  }

  // 触发 ②: 连续失败 (3+ 次)
  const fails = opts.consecutiveFailures || 0;
  if (fails >= 3) {
    // 用最近一次 @ 的远端 channel; 没有则取 remoteChannels[0]
    const lastMention = [...opts.text.matchAll(mentionRe)].pop();
    let rc = opts.remoteChannels[0];
    if (lastMention) {
      const found = opts.remoteChannels.find(c => c.name === lastMention[1]);
      if (found) rc = found;
    }
    if (rc && rc._ownerPublicKey) {
      return {
        shouldLoad: true,
        reason: 'consecutive-failure',
        remotePublicKey: rc._ownerPublicKey,
        triggerValue: rc.name,
      };
    }
  }

  return { shouldLoad: false };
}

// ============== 失败计数器 (内存) ==============

const failureCounters: Map<string, number> = new Map();

export function recordFailure(channelId: string): number {
  const cur = (failureCounters.get(channelId) || 0) + 1;
  failureCounters.set(channelId, cur);
  return cur;
}

export function clearFailure(channelId: string): void {
  failureCounters.delete(channelId);
}

export function getFailures(channelId: string): number {
  return failureCounters.get(channelId) || 0;
}