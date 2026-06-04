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
  buildAgentDelegateRequest, buildAgentResponse, buildManifestPayload, buildManifestRequest,
  parseFrame, setLocalManifest, addLocalAgent, getLocalManifest, getRemoteManifests,
  cacheRemoteManifest, pickAgent, type AgentManifestEntry, type AgentManifest,
} from '../agents/agent-manifest-protocol.js';

export interface DelegateTransport {
  /** 发送 frame 到指定节点公钥, 等待回包. null 表示不实现 (同步返回占位) */
  sendToNode(publicKey: string, frame: string, timeoutMs?: number): Promise<string | null>;
  /** 注册 onMessage: 对方 manifest_request 来了, 我方要回 manifest_payload */
  onIncomingFrame(handler: (fromPublicKey: string, frame: string) => Promise<string | null>): void;
}

export function createAgentDelegateApp(transport: DelegateTransport): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

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
        targetAgent: targetAgent || { id: f.payload.delegatedTo, capabilities: [capability], status: 'active', name: f.payload.delegatedTo },
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
      // 路由到本地匹配 agent
      const req = f.payload as any;
      const local = getLocalManifest();
      const target = local.agents.find((a) => a.capabilities.includes(req.capability) && a.status === 'active') || local.agents[0];
      if (!target) return buildAgentResponse({ ok: false, delegatedTo: 'none', summary: 'no local agent available' });
      return buildAgentResponse({
        ok: true,
        delegatedTo: target.id,
        resultCid: `mock-${Date.now()}`,
        summary: `[${target.name}] 已处理任务: ${req.instruction?.substring(0, 30)}`,
      });
    }
    return null;
  });

  return app;
}
