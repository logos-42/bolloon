/**
 * agent-delegate-server - 把 manifest + agent_delegate 协议挂到 Web API
 *
 * 启动: PORT=54189 npx tsx src/web/agent-delegate-server.ts
 *
 * 提供:
 *   GET  /api/agent/local-manifest          — 本节点智能体清单
 *   POST /api/agent/register                — 注册/更新本节点智能体
 *   GET  /api/agent/remote-manifests        — 缓存的远端 manifest 列表
 *   POST /api/agent/pick                    — 按 capability + 可选 ownerPublicKey 选 agent
 *   POST /api/agent/delegate                — DOC 驱动委派 (转发到对端 agent)
 *
 * 该模块不直接绑 Hyperswarm — 通过注入的 transport 抽象:
 *   - sendToNode(nodeId, frame) -> Promise<responseFrame>
 *
 * 主进程接入时把 Hyperswarm 拨号逻辑包成 transport 注入。
 */

import express from 'express';
import {
  buildAgentDelegateRequest, buildAgentResponse, buildManifestPayload,
  parseFrame, setLocalManifest, getLocalManifest, getRemoteManifests,
  cacheRemoteManifest, pickAgent, type AgentManifestEntry, type AgentManifest,
} from '../agents/agent-manifest-protocol.js';

export interface DelegateTransport {
  /** 发送 frame 到指定节点公钥, 等待回包. null 表示不实现 (同步返回占位) */
  sendToNode(publicKey: string, frame: string, timeoutMs?: number): Promise<string | null>;
  /** 注册 onMessage: 对方 manifest_request 来了, 我方要回 manifest_payload */
  onIncomingFrame(handler: (fromPublicKey: string, frame: string) => Promise<string | null>): void;
}

/**
 * 2026-09-15: 被委派的**真执行器**。
 *
 * 背景: 此前 agent_delegate 的处理是占位 —— 挑到 agent 就回 `resultCid: mock-<ts>` +
 * `summary:'已处理任务: <指令前 30 字>'`, **什么也没干**, 收到委派的一方等于假签收。
 * 现在由宿主注入真执行器 (通常 = 跑本地 agent session + 把结果存进 OrbitDB 拿真 CID);
 * 宿主没注入 → 如实回 ok:false / error:'no-executor', 绝不假装执行。
 */
export interface DelegateExecutionRequest {
  /** 请求的能力 (必须与本地 agent 的 capabilities 匹配) */
  capability: string;
  instruction: string;
  docPath?: string;
  docContent?: string;
  fromAgentId?: string;
  /** 发起方节点公钥 (transport 视角, 通常是 iroh nodeId 或 Hyperswarm peer key) */
  fromPublicKey: string;
  /** 本机被选中的 agent */
  targetAgentId: string;
  targetAgentName: string;
}

export interface DelegateExecutionResult {
  ok: boolean;
  /** 给委派方看的结果摘要 */
  summary: string;
  /** 真实内容寻址 CID (执行器真存了才有; 不填就是不填, 不再编 mock-) */
  resultCid?: string;
  error?: string;
}

export interface AgentDelegateAppOptions {
  /** 真执行器 (缺失 = 本节点只能匹配不能干活, 会如实报 no-executor) */
  execute?: (req: DelegateExecutionRequest) => Promise<DelegateExecutionResult>;
  /** 单次执行超时 (毫秒, 默认 60000) — 超时如实报错, 不返回半截结果 */
  executeTimeoutMs?: number;
}

export function createAgentDelegateApp(transport: DelegateTransport, options: AgentDelegateAppOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const executeTimeoutMs = options.executeTimeoutMs ?? 60_000;

  // ---- 本地 manifest ----
  app.get('/api/agent/local-manifest', (_req, res) => {
    res.json(getLocalManifest());
  });

  app.post('/api/agent/register', (req, res) => {
    const body = req.body as { agents: AgentManifestEntry[]; ownerName?: string; ownerPublicKey?: string };
    if (!body.agents || !Array.isArray(body.agents)) {
      return res.status(400).json({ error: 'agents array required' });
    }
    setLocalManifest({
      ownerName: body.ownerName || getLocalManifest().ownerName || 'unknown',
      ownerPublicKey: body.ownerPublicKey || getLocalManifest().ownerPublicKey || '',
      agents: body.agents,
    });
    res.json({ ok: true, manifest: getLocalManifest() });
  });

  // ---- 远端 manifest 列表 ----
  app.get('/api/agent/remote-manifests', (_req, res) => {
    res.json({ count: getRemoteManifests().length, manifests: getRemoteManifests() });
  });

  // ---- 按 capability 选 agent ----
  app.post('/api/agent/pick', (req, res) => {
    const { capability, ownerPublicKey } = req.body as { capability: string; ownerPublicKey?: string };
    if (!capability) return res.status(400).json({ error: 'capability required' });
    const picked = pickAgent(capability, ownerPublicKey);
    if (!picked) return res.status(404).json({ error: 'no matching agent', capability });
    res.json({ ok: true, agent: picked.agent, owner: { name: picked.owner.ownerName, publicKey: picked.owner.ownerPublicKey } });
  });

  // ---- DOC 驱动委派 ----
  app.post('/api/agent/delegate', async (req, res) => {
    try {
      const { toPublicKey, capability, docPath, docContent, instruction, fromAgentId } = req.body as {
        toPublicKey: string;
        capability: string;
        docPath?: string;
        docContent?: string;
        instruction: string;
        fromAgentId?: string;
      };
      if (!toPublicKey || !capability || !instruction) {
        return res.status(400).json({ error: 'toPublicKey, capability, instruction required' });
      }

      // 1) 优先从已缓存的远端 manifest 里选 agent
      let targetAgent: AgentManifestEntry | null = null;
      const remote = getRemoteManifests().find((m) => m.ownerPublicKey === toPublicKey || m.ownerPublicKey.startsWith(toPublicKey.substring(0, 16)));
      if (remote) {
        targetAgent = remote.agents.find((a) => a.capabilities.includes(capability) && a.status === 'active') || null;
      }

      // 2) 构造 frame, 通过 transport 发送
      const frame = buildAgentDelegateRequest({
        capability,
        docPath,
        docContent,
        instruction,
        fromAgentId: fromAgentId || 'local-user',
      });

      const replyFrame = await transport.sendToNode(toPublicKey, frame, 30000);
      if (!replyFrame) {
        return res.status(504).json({ error: 'no response from peer (timeout or transport not wired)' });
      }
      const f = parseFrame(replyFrame);
      if (!f || f.type !== 'agent_response') {
        return res.status(502).json({ error: 'bad response', frame: replyFrame });
      }
      res.json({
        ok: true,
        // 2026-09-15: 没缓存到对端 manifest 就如实给 null —— 旧版会编一个
        // 「capabilities:[capability], name:<id>」的假目标, 让人以为已经知道对端是谁。
        targetAgent: targetAgent || null,
        targetAgentKnown: !!targetAgent,
        response: f.payload,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- 接收对方 manifest_request / agent_delegate 处理 ----
  // 业务端需要把对端来的入站 frame 转给本 handler
  // 简化: 把 handler 挂到 transport.onIncomingFrame
  transport.onIncomingFrame(async (fromPublicKey, frame) => {
    const f = parseFrame(frame);
    if (!f) return null;
    if (f.type === 'manifest_request') {
      return buildManifestPayload(getLocalManifest());
    }
    if (f.type === 'manifest_payload') {
      cacheRemoteManifest(f.payload as AgentManifest);
      return null;  // 不需要回包
    }
    if (f.type === 'agent_delegate') {
      const req = f.payload as any;
      const capability = String(req?.capability || '');
      // 2026-09-15: 严格按文档 §6 / §9 —— 只认 capabilities 含该能力且 active 的 agent。
      //   旧实现 `|| local.agents[0]` 会把不匹配的指令塞给任意一个本地 agent,
      //   与「pick 404 = 没有匹配能力」的语义自相矛盾。
      const local = getLocalManifest();
      const target = local.agents.find((a) => a.capabilities.includes(capability) && a.status === 'active');
      if (!target) {
        return buildAgentResponse({
          ok: false,
          delegatedTo: 'none',
          summary: `no local agent available for capability '${capability}'`,
          error: 'no-capability-match',
        });
      }
      // 匹配到了, 但本节点没接执行器 → 如实说"干不了", 不假签收
      if (!options.execute) {
        return buildAgentResponse({
          ok: false,
          delegatedTo: target.id,
          summary: `matched agent '${target.name}' but this node has no executor wired`,
          error: 'no-executor',
        });
      }
      try {
        const raced = await Promise.race([
          options.execute({
            capability,
            instruction: String(req?.instruction || ''),
            docPath: req?.docPath ? String(req.docPath) : undefined,
            docContent: req?.docContent ? String(req.docContent) : undefined,
            fromAgentId: req?.fromAgentId ? String(req.fromAgentId) : undefined,
            fromPublicKey,
            targetAgentId: target.id,
            targetAgentName: target.name,
          }),
          new Promise<DelegateExecutionResult>((resolve) =>
            setTimeout(() => resolve({ ok: false, summary: `executor timed out after ${executeTimeoutMs}ms`, error: 'executor-timeout' }), executeTimeoutMs)),
        ]);
        return buildAgentResponse({
          ok: !!raced.ok,
          delegatedTo: target.id,
          resultCid: raced.resultCid,
          summary: String(raced.summary || '').slice(0, 4000),
          error: raced.error,
        });
      } catch (e: any) {
        return buildAgentResponse({
          ok: false,
          delegatedTo: target.id,
          summary: `executor threw: ${String(e?.message || e).slice(0, 300)}`,
          error: 'executor-error',
        });
      }
    }
    return null;
  });

  return app;
}
