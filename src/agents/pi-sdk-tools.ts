import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { documentReader, DocumentContent } from '../documents/reader.js';
import { p2pNetwork } from '../network/p2p.js';
import { shellExec } from './shell-tool.js';
import { checkWritePath } from './shell-guard.js';
import { p2pDocumentTools, initDocumentReceiver } from './p2p-document-tools.js';
import { runSelfImproveLoop } from './pi-sdk-session-factory.js';
import type { Tool, ToolResult } from './pi-sdk-types.js';
import type { PersonaDoc } from '../social/heartbeat.js';
import { getMinimax } from '../constraints/index.js';
import { delegateToEngine } from '../external-engines/delegate.js';

/**
 * Tools 模块 — 从 pi-sdk.ts 抽出的 registerTools() / _registerWalletTools() / _setupInboxListener()
 * / wrapToolsWithIdempotency() (2026-07-06).
 *
 * 三个工具来源:
 *   1. 内置工具: read_document, summarize_document, improve_document, list_peers, send_message,
 *      broadcast_message, list_local_channels, send_to_channel, check_inbox, send_to_peer,
 *      p2p_broadcast, agent_call, get_identity, set_persona, get_operation_logs, list_files,
 *      read_directory, shell_exec, self_improve, list_skills, use_skill, write_file, edit_file,
 *      git_diff, git_commit, git_push, git_branch, read_file, delete_file, mkdir, move_file,
 *      grep_files, glob_files, git_log, git_show, git_stash, vitest_run, tsc_check, create_task,
 *      update_task, get_task, list_tasks, p2pDocumentTools
 *   2. 钱包工具 (EVM / Polymarket / Safe) — 单独的 _registerWalletTools
 *   3. P2P 消息 inbox 监听 — _setupInboxListener
 *
 * 调用方: PiAgentSession.registerTools() 会调下面的三个函数, 并执行
 *   wrapToolsWithIdempotency + 镜像到 ToolRegistry.
 *
 * 工具缓存策略: SIDE_EFFECT_TOOLS 子集 (write_file / edit_file / shell_exec / git_commit 等)
 *   走幂等性 cache, 防止 LLM loop 重试时副作用执行两次.
 */

export const SIDE_EFFECT_TOOLS = new Set([
  'write_file', 'edit_file', 'shell_exec', 'git_commit', 'git_push', 'git_branch',
  'create_task', 'update_task',
]);

/**
 * 注册内置工具 (不含 wallet 工具). 返回 Tool 数组 (wallet 工具单独注册).
 * 接收外部 this.tools Map 以便填充, 但为了避免循环依赖, 这里返回 tools 数组 + handlers.
 *
 * 实际上: 调用方传一个 registry object {tools: Map, _inboxMessages: array, sessionManager, identity, ...}
 *   这里直接 mutate registry.tools.
 */
export interface ToolRegistryContext {
  tools: Map<string, Tool>;
  cwd: string;
  identity: { did: string; name: string };
  persona: PersonaDoc | null;
  minimaxAvailable: boolean;
  setPersona: (p: PersonaDoc) => Promise<void>;
  sessionManager: { addFileContext: (path: string, text: string) => void };
  constraintLayer: { getLogs: () => any[] };
  /** P2P inbox 缓存 — _setupInboxListener 写入 */
  _inboxMessages: { id: string; from: string; fromDid?: string; type: string; payload: string; timestamp: number; source: 'p2p' | 'local' }[];
  /**
   * 获取当前 channel 已加密存储的钱包信息 (用于自动支付).
   * 返回 null 表示未绑定或未加密存储私钥.
   */
  getChannelWallet?: () => Promise<{
    encryptedPrivateKey: string;
    encryptedPrivateKeyIv: string;
    walletAddress: string;
    autoPayEnabled: boolean;
    did: string;
  } | null>;
}

export function registerBuiltinTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('read_document', {
    name: 'read_document',
    description: '读取文档内容，支持 .txt, .md, .pdf, .docx 格式',
    parameters: { path: '文件路径 (必填)' },
    execute: async (args) => {
      try {
        const path = String(args.path || '').trim();
        if (!path) return { success: false, error: 'path 必填' };
        const content: DocumentContent = await documentReader.read(path);
        return {
          success: true,
          output: `📄 ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n\n${content.text.substring(0, 1000)}${content.text.length > 1000 ? '...' : ''}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  ctx.tools.set('summarize_document', {
    name: 'summarize_document',
    description: '总结文档内容，分析并生成摘要',
    parameters: { path: '文件路径 (必填)', context: '可选, 总结上下文提示' },
    execute: async (args) => {
      try {
        const path = String(args.path || '').trim();
        if (!path) return { success: false, error: 'path 必填' };
        if (!ctx.minimaxAvailable) {
          return { success: false, error: 'LLM未初始化，请设置 MINIMAX_API_KEY' };
        }
        // summarizeDocument 走 PiAgentSession.summarizeDocument, 这里通过 tools 反向调用不好处理
        // 简化: 让 LLM 自己直接走 shell_exec / use_skill 路径
        const llm = getMinimax();
        const content = await documentReader.read(path);
        const r = await llm.summarize(content.text, args.context);
        return {
          success: true,
          output: `📝 摘要:\n${r.summary}\n\n质量评分: ${(r.qualityScore * 10).toFixed(1)}/10`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  ctx.tools.set('improve_document', {
    name: 'improve_document',
    description: '根据要求改进文档内容',
    parameters: { path: '文件路径 (必填)', requirements: '改进要求 (必填)' },
    execute: async (args) => {
      try {
        const path = String(args.path || '').trim();
        if (!path) return { success: false, error: 'path 必填' };
        const requirements = String(args.requirements || '').trim();
        if (!requirements) return { success: false, error: 'requirements 必填' };
        if (!ctx.minimaxAvailable) {
          return { success: false, error: 'LLM未初始化，请设置 MINIMAX_API_KEY' };
        }
        const llm = getMinimax();
        const content = await documentReader.read(path);
        const improved = await llm.summarize(content.text + '\n\n改进要求: ' + requirements, undefined);
        return {
          success: true,
          output: `✅ 改进完成\n质量评分: ${(improved.qualityScore * 10).toFixed(1)}/10\n${improved.summary ? '\n改进内容:\n' + improved.summary.substring(0, 500) + '...' : ''}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  ctx.tools.set('list_peers', {
    name: 'list_peers',
    description: '列出已连接的对等节点',
    parameters: {},
    execute: async () => {
      const peers = p2pNetwork.getPeers();
      if (peers.length === 0) {
        return { success: true, output: '当前无连接的对等节点' };
      }
      return { success: true, output: `已连接节点 (${peers.length}):\n${peers.map(p => `  - ${p}`).join('\n')}` };
    }
  });

  ctx.tools.set('send_message', {
    name: 'send_message',
    description: '向指定对等节点发送消息',
    parameters: { peer_id: '对等节点ID', message: '消息内容' },
    execute: async (args) => {
      try {
        await p2pNetwork.sendMessage(args.peer_id, 'message', args.message);
        return { success: true, output: `消息已发送到 ${args.peer_id}` };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  ctx.tools.set('broadcast_message', {
    name: 'broadcast_message',
    description: '向所有对等节点广播消息',
    parameters: { message: '消息内容' },
    execute: async (args) => {
      try {
        await p2pNetwork.broadcast('message', args.message);
        return { success: true, output: '消息已广播到所有节点' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  // Agent Mesh 工具集
  ctx.tools.set('list_local_channels', {
    name: 'list_local_channels',
    description: '列出当前 PiAgentSession 注册的所有 channel. 每个 channel 是 bolloon 内的智能体会话, 可含 messages[] / peerDid(对端 DID) / peerName. 供 send_to_channel 选 channel_id.',
    parameters: {},
    execute: async () => {
      const channels = ctx.sessionManager ? (ctx.sessionManager as any).getAllChannels?.() || [] : [];
      if (channels.length === 0) {
        return { success: true, output: '📭 当前 session 没有注册任何 channel (用 send_to_channel 留空 channel_id 会自动创建一个)' };
      }
      const lines = channels.map((ch: any, i: number) => {
        const peer = ch.peerDid ? ` peer=${ch.peerDid.substring(0, 20)}` : (ch.peerName ? ` peer="${ch.peerName}"` : '');
        const msgCount = ch.messages?.length || 0;
        return `  ${i + 1}. ${ch.id} name="${ch.name}" msgs=${msgCount}${peer}`;
      });
      return { success: true, output: `📬 当前 session 有 ${channels.length} 个 channel:\n${lines.join('\n')}` };
    }
  });

  ctx.tools.set('send_to_channel', {
    name: 'send_to_channel',
    description: '发送消息到指定 channel. channel_id 留空会自动创建一个. 如果 channel 已关联 peerDid, 会同时通过 P2P 转发到对端 agent.',
    parameters: { channel_id: '目标 channel id (留空自动创建)', message: '消息内容 (必填)', peer_did: '可选 创建新 channel 时绑定的对端 DID (e.g. did:key:...)' },
    execute: async (args) => {
      const message = String(args.message || '').trim();
      if (!message) return { success: false, error: 'message 必填' };
      let channelId = String(args.channel_id || '').trim();
      const peerDid = args.peer_did ? String(args.peer_did) : undefined;
      if (!channelId) {
        const ch = await (ctx.sessionManager as any).getOrCreatePeerChannel(peerDid || 'auto-created', 'auto-created');
        channelId = ch.id;
      }
      const ch = (ctx.sessionManager as any).getAllChannels().find((c: any) => c.id === channelId);
      if (ch?.peerDid) {
        try {
          const peerId = ch.peerDid.replace(/^did:key:/, '').replace(/^did:pi:/, '');
          await p2pNetwork.sendMessage(peerId, 'channel-message', JSON.stringify({ channelId, content: message, from: ctx.identity.did, timestamp: new Date().toISOString() }));
          return { success: true, output: `📨 消息已存到 channel ${channelId} + P2P 转发到 ${ch.peerDid.substring(0, 30)}...` };
        } catch (e) {
          return { success: true, output: `📨 消息已存到 channel ${channelId} (P2P 转发失败: ${String(e).slice(0, 100)})` };
        }
      }
      return { success: true, output: `📨 消息已存到 channel ${channelId}` };
    }
  });

  ctx.tools.set('check_inbox', {
    name: 'check_inbox',
    description: '检查 P2P + 本地 inbox 收到的所有消息. 跨 channel 视角, 按时间倒序.',
    parameters: { max: '可选, 最多返回 N 条 (默认 50)' },
    execute: async (args) => {
      const max = Number(args.max) || 50;
      if (ctx._inboxMessages.length === 0) {
        return { success: true, output: '📭 当前 inbox 空' };
      }
      const slice = ctx._inboxMessages.slice(-max).reverse();
      const lines = slice.map((m: any, i: number) => {
        const fromTxt = m.fromDid ? `${m.from} (${m.fromDid.substring(0, 20)}...)` : m.from;
        return `  ${i + 1}. [${m.type}] from=${fromTxt} time=${new Date(m.timestamp).toISOString()} src=${m.source}\n     ${String(m.payload).substring(0, 200)}`;
      });
      return { success: true, output: `📬 inbox 有 ${ctx._inboxMessages.length} 条消息 (最近 ${slice.length}):\n${lines.join('\n')}` };
    }
  });

  ctx.tools.set('send_to_peer', {
    name: 'send_to_peer',
    description: '发送结构化消息到指定 P2P 节点 (远端 bolloon 实例). 对方会通过远端 channel 收到.',
    parameters: { peer_id: '目标 P2P 节点 publicKey (用 list_peers 查)', message: '消息内容 (任意字符串)', type: '可选, 消息类型标签 (默认 agent-message)' },
    execute: async (args) => {
      const peerId = String(args.peer_id || '').trim();
      const msg = String(args.message || '').trim();
      const type = String(args.type || 'agent-message').trim();
      if (!peerId) return { success: false, error: 'peer_id 必填' };
      if (!msg) return { success: false, error: 'message 必填' };
      try {
        await p2pNetwork.sendMessage(peerId, type, msg);
        return { success: true, output: `✅ 消息已发送到 ${peerId.substring(0, 16)}...` };
      } catch (e) {
        return { success: false, error: `发送失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('p2p_broadcast', {
    name: 'p2p_broadcast',
    description: '广播消息到所有连接的 P2P 节点',
    parameters: { message: '消息内容', type: '可选, 消息类型标签 (默认 agent-broadcast)' },
    execute: async (args) => {
      const msg = String(args.message || '').trim();
      const type = String(args.type || 'agent-broadcast').trim();
      if (!msg) return { success: false, error: 'message 必填' };
      try {
        await p2pNetwork.broadcast(type, msg);
        return { success: true, output: `📡 已广播 type=${type}` };
      } catch (e) {
        return { success: false, error: `广播失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('agent_call', {
    name: 'agent_call',
    description: 'RPC: 让远端 P2P agent 跑一个任务, 等待结果返回. 远端 agent 会基于 task 描述自主完成, 完成后回复. (RPC 结果回收机制待实现)',
    parameters: { peer_id: '目标 P2P 节点', task: '任务描述 (远端 agent 收到的 prompt)', timeoutMs: '可选 超时 (ms, 默认 30000)' },
    execute: async (args) => {
      const peerId = String(args.peer_id || '').trim();
      const task = String(args.task || '').trim();
      if (!peerId) return { success: false, error: 'peer_id 必填' };
      if (!task) return { success: false, error: 'task 必填' };
      const requestId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await p2pNetwork.sendMessage(peerId, 'agent-call', JSON.stringify({ requestId, task, from: ctx.identity.did }));
      return { success: true, output: `📞 RPC 任务已发送给 ${peerId.substring(0, 16)}...\n   requestId=${requestId}` };
    }
  });

  // add_friend_by_id — 通过 Hyperswarm publicKey 添加 P2P 好友
  ctx.tools.set('add_friend_by_id', {
    name: 'add_friend_by_id',
    description: '通过 Hyperswarm P2P publicKey (64 字符 hex) 添加好友. 对方在线时会收到好友申请弹窗, 接受后自动分享 channel. 强烈建议填 note 备注 (自我介绍/来源), 对方才能分辨你是谁.',
    parameters: {
      publicKey: '64 字符 hex publicKey (必填)',
      name: '可选, 给好友的备注名 (如: 同事-张磊)',
      message: '可选, 附加的好友申请消息',
      note: '可选, 备注 (自我介绍/来源), 对方接受时会看到. 如 "我是[姓名]的 Bolloon agent[name], 来自[来源], 想加你为好友共享 channel 协作,技能: [技能列表]"'
    },
    execute: async (args) => {
      const publicKey = String(args.publicKey || '').trim();
      const name = String(args.name || '').trim();
      const message = String(args.message || '想加你为 P2P 好友, 共享 channel 协作').trim();
      const note = String(args.note || '').trim();
      if (!publicKey || publicKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(publicKey)) {
        return { success: false, error: 'publicKey 必须是 64 字符 hex 格式' };
      }
      try {
        const port = process.env.PORT || '54188';
        const res = await fetch(`http://127.0.0.1:${port}/api/friend-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPublicKey: publicKey, name: name || undefined, message, note: note || undefined })
        });
        const data = await res.json();
        if (!res.ok) {
          const reason = data.code === 'NO_CONN' ? '对方未在线, 已本地记住, 等对方上线后自动重连' : (data.error || '请求失败');
          return { success: false, error: `添加好友失败: ${reason}`, output: data.persistedAs ? `本地已保存为: ${data.persistedAs}` : undefined };
        }
        return { success: true, output: `✅ 好友申请已发送给 ${data.persistedAs || name || publicKey.substring(0, 12)}...\n对方接受后会自动出现在 P2P 好友列表.` };
      } catch (e: any) {
        return { success: false, error: `添加好友失败: ${String(e.message || e)}` };
      }
    }
  });

  // list_pending_friend_requests — 查看待处理的好友申请 (智能体侧处理入口)
  ctx.tools.set('list_pending_friend_requests', {
    name: 'list_pending_friend_requests',
    description: '查看当前待处理的好友申请列表 (对方想加你为好友但还没接受). 每个申请带 fromName / note 备注 (自我介绍/来源), 便于判断是否接受. 用 accept_friend_request 接受, 或 ignore_friend_request 忽略.',
    parameters: {},
    execute: async () => {
      try {
        const port = process.env.PORT || '54188';
        const res = await fetch(`http://127.0.0.1:${port}/api/friend-requests`);
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error || '查询失败' };
        if (data.count === 0) {
          return { success: true, output: '当前没有待处理的好友申请。' };
        }
        const lines = data.requests.map((r: any, i: number) =>
          `${i + 1}. ${r.fromName} (publicKey=${r.fromPublicKey.substring(0, 16)}...)\n   备注: ${r.note || r.message || '(无)'}\n   requestId: ${r.requestId}`
        );
        return { success: true, output: `待处理好友申请 ${data.count} 个:\n${lines.join('\n')}\n\n用 accept_friend_request 接受, 或 ignore_friend_request 忽略.` };
      } catch (e: any) {
        return { success: false, error: `查询好友申请失败: ${String(e.message || e)}` };
      }
    }
  });

  // accept_friend_request — 接受一个待处理的好友申请 (智能体侧一键通过)
  ctx.tools.set('accept_friend_request', {
    name: 'accept_friend_request',
    description: '接受一个待处理的好友申请. 对方会出现在你的 P2P 好友列表, 对方分享的 channel 自动可见. 参数 requestId 来自 list_pending_friend_requests 的返回.',
    parameters: {
      requestId: '待处理申请的 requestId (必填, 来自 list_pending_friend_requests)',
      name: '可选, 给这个新好友的备注名 (默认用对方自称的名字)'
    },
    execute: async (args) => {
      const requestId = String(args.requestId || '').trim();
      if (!requestId) {
        return { success: false, error: 'requestId 必填 (先调 list_pending_friend_requests 获取)' };
      }
      try {
        const port = process.env.PORT || '54188';
        // 先查 pending 拿到 fromPublicKey / fromName
        const q = await fetch(`http://127.0.0.1:${port}/api/friend-requests`);
        const qd = await q.json();
        const req = (qd.requests || []).find((r: any) => r.requestId === requestId);
        if (!req) {
          return { success: false, error: `未找到 requestId=${requestId} 的申请 (可能已被处理或过期)` };
        }
        const acceptName = String(args.name || '').trim() || req.fromName;
        const res = await fetch(`http://127.0.0.1:${port}/api/friend-accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromPublicKey: req.fromPublicKey, name: acceptName, requestId })
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error || '接受失败' };
        return { success: true, output: `✅ 已接受 ${req.fromName} 的好友申请 (备注: ${req.note || req.message || '(无)'}), 已加为好友: ${data.persistedAs || acceptName}` };
      } catch (e: any) {
        return { success: false, error: `接受好友申请失败: ${String(e.message || e)}` };
      }
    }
  });

  // ignore_friend_request — 忽略一个待处理的好友申请
  ctx.tools.set('ignore_friend_request', {
    name: 'ignore_friend_request',
    description: '忽略 (拒绝) 一个待处理的好友申请, 不加入好友. 参数 requestId 来自 list_pending_friend_requests 的返回.',
    parameters: {
      requestId: '待处理申请的 requestId (必填, 来自 list_pending_friend_requests)'
    },
    execute: async (args) => {
      const requestId = String(args.requestId || '').trim();
      if (!requestId) return { success: false, error: 'requestId 必填' };
      try {
        const port = process.env.PORT || '54188';
        const res = await fetch(`http://127.0.0.1:${port}/api/friend-requests/ignore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId })
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error || '忽略失败' };
        return { success: true, output: `已忽略好友申请 ${requestId.substring(0, 8)}...` };
      } catch (e: any) {
        return { success: false, error: `忽略好友申请失败: ${String(e.message || e)}` };
      }
    }
  });

  // delegate_to_engine — 把编码任务委派给本机已安装的其他 AI 编码智能体 CLI
  // (codex / claude-code / opencode / openclaw / hermes). 它们必须已安装且可达 PATH.
  // 实验 API 引擎 (experiment:xxx) 是供应商不是 CLI, 不支持委派, 工具会提示改用 import.
  ctx.tools.set('delegate_to_engine', {
    name: 'delegate_to_engine',
    description: '把编码任务委派给本机已安装的其他 AI 编码智能体 (子智能体) 执行: codex / claude-code / opencode / openclaw / hermes. 引擎需已安装且在 PATH 上. 返回其执行输出. 注意: 各工具 CLI 的非交互参数随版本变化, 若报错请检查该工具版本对应 flag.',
      parameters: {
        engine: "引擎 id: codex / claude-code / opencode / openclaw / hermes (实验 API 不支持委派)",
        prompt: '派发的任务描述 (作为单参数传给该引擎 CLI)',
        model: '可选, 强制指定模型 (如 deepseek/deepseek-v4-flash), 需引擎支持',
        cwd: '可选, 工作目录, 默认当前目录'
      },
      execute: async (args) => {
        const engine = String(args.engine || '').trim();
        const prompt = String(args.prompt || '').trim();
        if (!engine) return { success: false, error: 'engine 必填' };
        if (!prompt) return { success: false, error: 'prompt 必填' };
        const cwd = args.cwd ? String(args.cwd).trim() : undefined;
        const model = args.model ? String(args.model).trim() : undefined;
        const result = await delegateToEngine(engine, prompt, { cwd: cwd || undefined, ...(model ? { model } : {}) });
      if (!result.success) {
        return { success: false, error: result.error, output: result.output };
      }
      return {
        success: true,
        output: `🤖 ${engine} 执行结果 (exitCode=${result.exitCode}):\n${result.output || '(无输出)'}`
      };
    }
  });

  ctx.tools.set('get_identity', {
    name: 'get_identity',
    description: '获取当前智能体身份信息',
    parameters: {},
    execute: async () => {
      const id = ctx.identity;
      return {
        success: true,
        output: `DID: ${id.did}\n名称: ${id.name}\n`
      };
    }
  });

  ctx.tools.set('set_persona', {
    name: 'set_persona',
    description: '更新智能体的 persona 信息',
    parameters: { persona_json: 'Persona JSON 对象' },
    execute: async (args) => {
      try {
        const personaData = typeof args.persona_json === 'string' ? JSON.parse(args.persona_json) : args.persona_json;
        const now = new Date().toISOString();
        const newPersona: PersonaDoc = {
          name: personaData.name || ctx.identity.name,
          description: personaData.description || '',
          capabilities: personaData.capabilities || [],
          personality: personaData.personality || '',
          greeting: personaData.greeting || '',
          interests: personaData.interests || [],
          createdAt: ctx.persona?.createdAt || now,
          updatedAt: now
        };
        await ctx.setPersona(newPersona);
        return { success: true, output: `Persona 已更新:\n名称: ${newPersona.name}\n描述: ${newPersona.description}` };
      } catch (e) {
        return { success: false, error: `更新 persona 失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('get_operation_logs', {
    name: 'get_operation_logs',
    description: '获取约束层的操作日志',
    parameters: {},
    execute: async () => {
      const logs = ctx.constraintLayer.getLogs();
      if (logs.length === 0) {
        return { success: true, output: '暂无操作日志' };
      }
      return {
        success: true,
        output: `操作日志 (${logs.length} 条):\n${logs.slice(-10).map((l: any) => `[${new Date(l.timestamp).toISOString()}] ${l.action} - ${l.status}`).join('\n')}`
      };
    }
  });

  // 文件系统工具
  ctx.tools.set('list_files', {
    name: 'list_files',
    description: '列出目录中的文件',
    parameters: { path: '目录路径（可选，默认为当前目录）' },
    execute: async (args) => {
      try {
        const fs = await import('fs');
        const targetPath = args.path || ctx.cwd;
        const files = fs.readdirSync(targetPath);
        return {
          success: true,
          output: `📁 目录 ${targetPath} 中的文件 (${files.length} 个):\n${files.slice(0, 20).map((f: string) => `  - ${f}`).join('\n')}${files.length > 20 ? '\n  ...' : ''}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  ctx.tools.set('read_directory', {
    name: 'read_directory',
    description: '读取目录内容，返回文件列表和目录结构',
    parameters: { path: '目录路径（可选，默认为当前目录）' },
    execute: async (args) => {
      try {
        const fs = await import('fs');
        const pathModule = await import('path');
        const targetPath = args.path || ctx.cwd;
        const items = fs.readdirSync(targetPath);
        const result: string[] = [];
        for (const item of items.slice(0, 30)) {
          const fullPath = pathModule.join(targetPath, item);
          try {
            const stat = fs.statSync(fullPath);
            const type = stat.isDirectory() ? '📁' : '📄';
            result.push(`${type} ${item}${stat.isDirectory() ? '/' : ''}`);
          } catch {
            result.push(`📄 ${item}`);
          }
        }
        return {
          success: true,
          output: `📂 ${targetPath} (${items.length} 项):\n${result.join('\n')}${items.length > 30 ? '\n... 还有更多文件' : ''}`
        };
      } catch (e) {
        return { success: false, error: `无法读取目录: ${String(e)}` };
      }
    }
  });

  // P2P Document Tools
  for (const tool of p2pDocumentTools) {
    ctx.tools.set(tool.name, tool);
  }

  // shell_exec
  ctx.tools.set('shell_exec', {
    name: 'shell_exec',
    description: '在 cwd 跑 shell 命令. 仅支持白名单内命令: git, npm, npx, tsx, tsc, vitest, cat, head, tail, ls, wc, echo, pwd, date, mkdir, touch. 禁止管道/重定向/rm -rf/sudo. 命中护栏黑名单会被拒.',
    parameters: { command: '可执行文件 (必填, 必须在白名单)', args: '参数数组, 逗号分隔', timeoutMs: '超时毫秒, 默认 30000' },
    execute: async (args) => {
      const cmd = String(args.command || '').trim();
      if (!cmd) return { success: false, error: 'command 必填' };
      let argList: string[] = [];
      const rawArgs = args.args;
      if (Array.isArray(rawArgs)) {
        argList = rawArgs.map((s: any) => String(s).trim()).filter(Boolean);
      } else if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              argList = parsed.map((s: any) => String(s).trim()).filter(Boolean);
            }
          } catch { /* fall through to comma split */ }
        }
        if (argList.length === 0) {
          argList = trimmed.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      const timeoutMs = Number(args.timeoutMs) || 30000;
      const result = await shellExec(cmd, argList, { timeoutMs });
      if (result.deniedByGuard) {
        return { success: false, error: result.error };
      }
      if (!result.success) {
        return { success: false, error: result.error, output: result.output };
      }
      return { success: true, output: result.output };
    }
  });

  // self_improve
  ctx.tools.set('self_improve', {
    name: 'self_improve',
    description: '触发自我改进循环. AI 会在沙箱分支上工作, 跑 tsc + vitest 验证, 通过后输出分支名给用户审.',
    parameters: { goal: '本轮改进目标 (1 句话)' },
    execute: async (args) => {
      const goal = String(args.goal || '').trim();
      if (!goal) return { success: false, error: 'goal 必填' };
      return await runSelfImproveLoop(goal);
    }
  });

  // list_skills / use_skill — 走 skillRegistry
  // (由 registerBuiltinTools 调用方单独注册, 因为依赖 skillRegistry 实例)

  // write_file / edit_file / git_*
  ctx.tools.set('write_file', {
    name: 'write_file',
    description: '写入一个文件. 路径必须在白名单. 大文件 (> 100KB) 会被拒. 命中护栏黑名单会拒.',
    parameters: { path: '相对路径 (必填, 相对 cwd)', content: '文件内容 (必填)' },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      const content = String(args.content ?? '');
      if (!relPath) return { success: false, error: 'path 必填' };
      if (content.length > 100_000) return { success: false, error: `内容过大 (${content.length} > 100000 字节), 请分块写` };
      const pathResult = checkWritePath(relPath);
      if (!pathResult.allowed) {
        return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
      }
      try {
        const absPath = path.resolve(ctx.cwd, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content, 'utf-8');
        return { success: true, output: `✅ wrote ${relPath} (${content.length} bytes)` };
      } catch (e) {
        return { success: false, error: `写文件失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('edit_file', {
    name: 'edit_file',
    description: '编辑一个文件: 在 path 处查找 old_text, 替换为 new_text. 找不到 old_text 会失败.',
    parameters: { path: '相对路径 (必填)', old_text: '要替换的文本 (必填, 全文匹配)', new_text: '新文本 (必填)' },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      if (!relPath) return { success: false, error: 'path 必填' };
      if (!oldText) return { success: false, error: 'old_text 必填' };
      const pathResult = checkWritePath(relPath);
      if (!pathResult.allowed) {
        return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
      }
      try {
        const absPath = path.resolve(ctx.cwd, relPath);
        const original = await fs.readFile(absPath, 'utf-8');
        if (!original.includes(oldText)) {
          return { success: false, error: `old_text 在 ${relPath} 中未找到, 拒绝静默写入. 请先用 read_document 读最新内容.` };
        }
        const updated = original.replace(oldText, newText);
        await fs.writeFile(absPath, updated, 'utf-8');
        return { success: true, output: `✅ edited ${relPath} (${oldText.length} → ${newText.length} 字节)` };
      } catch (e) {
        return { success: false, error: `编辑文件失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('git_diff', {
    name: 'git_diff',
    description: '查看 git diff. 默认显示未提交改动 (staged + unstaged), 可指定 ref1..ref2 看两个 commit/分支之间的 diff. 输出会截到 8000 字符避免超长.',
    parameters: { range: '可选. e.g. "HEAD~3..HEAD". 省略则看未提交改动.' },
    execute: async (args) => {
      const range = String(args.range || '').trim();
      const argv = range ? ['diff', range] : ['diff'];
      const result = await shellExec('git', argv, { timeoutMs: 10_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      const out = (result.output || '').slice(0, 8000);
      return { success: true, output: out || '(空 diff — 没有未提交改动)' };
    }
  });

  ctx.tools.set('git_commit', {
    name: 'git_commit',
    description: 'git add -A + git commit. 提交信息由 LLM 提供. 不会 push.',
    parameters: { message: 'commit message (必填)' },
    execute: async (args) => {
      const message = String(args.message || '').trim();
      if (!message) return { success: false, error: 'message 必填' };
      const addResult = await shellExec('git', ['add', '-A'], { timeoutMs: 10_000 });
      if (addResult.deniedByGuard) return { success: false, error: addResult.error };
      if (!addResult.success) return { success: false, error: `git add 失败: ${addResult.error}` };
      try {
        const { spawn: spawnFn } = await import('child_process');
        const env = { ...process.env, BOLLOON_AUTO_EVOLVE: '1' };
        const output = await new Promise<string>((resolve, reject) => {
          const proc = spawnFn('git', ['commit', '-m', message], {
            cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = ''; let stderr = '';
          proc.stdout.on('data', (d: any) => stdout += d.toString());
          proc.stderr.on('data', (d: any) => stderr += d.toString());
          proc.on('close', (code: number) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `git commit exited ${code}`)));
          proc.on('error', reject);
        });
        return { success: true, output: `✅ committed: ${message.split('\n')[0]}\n${output}` };
      } catch (e) {
        return { success: false, error: `git commit 失败: ${String((e as Error).message || e).slice(0, 500)}` };
      }
    }
  });

  ctx.tools.set('git_push', {
    name: 'git_push',
    description: 'git push 当前分支到 origin. 命中护栏 (push to master/main, --force) 仍会被拒.',
    parameters: { remote: '可选, 默认 origin', branch: '可选, 默认当前分支' },
    execute: async (args) => {
      const remote = String(args.remote || 'origin').trim();
      const branch = String(args.branch || '').trim();
      const argv = branch ? ['push', remote, branch] : ['push', remote];
      const result = await shellExec('git', argv, { timeoutMs: 60_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      return { success: true, output: `✅ pushed to ${remote}${branch ? `/${branch}` : ''}\n${result.output || ''}` };
    }
  });

  ctx.tools.set('git_branch', {
    name: 'git_branch',
    description: 'git checkout -b <name> 或 git checkout <name>.',
    parameters: { name: '分支名 (必填)', create: '可选, "true" 表示创建新分支' },
    execute: async (args) => {
      const name = String(args.name || '').trim();
      const create = String(args.create || 'false') === 'true';
      if (!name) return { success: false, error: 'name 必填' };
      const argv = create ? ['checkout', '-b', name] : ['checkout', name];
      const result = await shellExec('git', argv, { timeoutMs: 10_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      return { success: true, output: `✅ ${create ? 'created + checked out' : 'checked out'} ${name}\n${result.output || ''}` };
    }
  });

  // 通用文件读取 (M4)
  ctx.tools.set('read_file', {
    name: 'read_file',
    description: '读取任意文件内容 (相对 cwd). 只读操作, 无白名单限制.',
    parameters: { path: '相对路径 (必填)', startLine: '起始行号 (可选, 默认 0)', maxLines: '最大行数 (可选, 默认 500)' },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      if (!relPath) return { success: false, error: 'path 必填' };
      try {
        const absPath = path.resolve(ctx.cwd, relPath);
        const content = fsSync.readFileSync(absPath, 'utf-8');
        const start = Math.max(0, parseInt(String(args.startLine || '0')) || 0);
        const max = parseInt(String(args.maxLines || '500')) || 500;
        const lines = content.split('\n');
        const slice = lines.slice(start, start + max);
        return { success: true, output: `📄 ${relPath} (第 ${start + 1}-${start + slice.length} 行, 共 ${lines.length} 行):\n${slice.map((l, i) => `${String(start + i + 1).padStart(4)} | ${l}`).join('\n')}` };
      } catch (e: any) {
        return { success: false, error: `读取失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('delete_file', {
    name: 'delete_file',
    description: '删除一个文件. 受 shell-guard 路径白名单保护. 不可恢复, 调用前请确认.',
    parameters: { path: '相对路径 (必填)' },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      if (!relPath) return { success: false, error: 'path 必填' };
      const pathResult = checkWritePath(relPath);
      if (!pathResult.allowed) return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
      try {
        const absPath = path.resolve(ctx.cwd, relPath);
        if (!fsSync.existsSync(absPath)) return { success: false, error: `文件不存在: ${relPath}` };
        fsSync.unlinkSync(absPath);
        return { success: true, output: `✅ deleted ${relPath}` };
      } catch (e: any) {
        return { success: false, error: `删除失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('mkdir', {
    name: 'mkdir',
    description: '创建一个或多个目录. 自动 mkdir -p.',
    parameters: { path: '目录路径 (必填, 相对 cwd)' },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      if (!relPath) return { success: false, error: 'path 必填' };
      const pathResult = checkWritePath(relPath);
      if (!pathResult.allowed) return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
      try {
        const absPath = path.resolve(ctx.cwd, relPath);
        fsSync.mkdirSync(absPath, { recursive: true });
        return { success: true, output: `✅ mkdir ${relPath}` };
      } catch (e: any) {
        return { success: false, error: `创建失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('move_file', {
    name: 'move_file',
    description: '移动或重命名文件. 源和目标路径都在白名单内才允许.',
    parameters: { from: '源路径 (必填)', to: '目标路径 (必填)' },
    execute: async (args) => {
      const from = String(args.from || '').trim();
      const to = String(args.to || '').trim();
      if (!from || !to) return { success: false, error: 'from 和 to 都必填' };
      const fromCheck = checkWritePath(from);
      if (!fromCheck.allowed) return { success: false, error: `from 路径被护栏拒: ${fromCheck.reason}` };
      const toCheck = checkWritePath(to);
      if (!toCheck.allowed) return { success: false, error: `to 路径被护栏拒: ${toCheck.reason}` };
      try {
        const fromAbs = path.resolve(ctx.cwd, from);
        const toAbs = path.resolve(ctx.cwd, to);
        if (!fsSync.existsSync(fromAbs)) return { success: false, error: `源文件不存在: ${from}` };
        fsSync.mkdirSync(path.dirname(toAbs), { recursive: true });
        fsSync.renameSync(fromAbs, toAbs);
        return { success: true, output: `✅ ${from} → ${to}` };
      } catch (e: any) {
        return { success: false, error: `移动失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('grep_files', {
    name: 'grep_files',
    description: '在文件中搜索匹配 pattern 的行. 类似 grep -rn. 只读操作, 无白名单限制.',
    parameters: { pattern: '搜索 pattern (必填, 字符串, 不是正则)', path: '搜索目录 (可选, 默认 .)', filePattern: '文件名 glob (可选)' },
    execute: async (args) => {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) return { success: false, error: 'pattern 必填' };
      const searchPath = String(args.path || '.').trim();
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const pExecFile = promisify(execFile);
        const argv = ['-rn', '--include=' + (args.filePattern || '*'), pattern, searchPath];
        const { stdout, stderr } = await pExecFile('grep', argv, { cwd: ctx.cwd, maxBuffer: 1024 * 1024 });
        const lines = stdout.split('\n').filter(Boolean).slice(0, 50);
        return { success: true, output: `🔍 grep "${pattern}" in ${searchPath} (${args.filePattern || '*'}, 最多 50 行):\n${lines.join('\n')}${lines.length === 50 ? '\n... (truncated)' : ''}` };
      } catch (e: any) {
        if (e.code === 1) return { success: true, output: `🔍 grep "${pattern}" in ${searchPath}: 0 matches` };
        return { success: false, error: `grep 失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('glob_files', {
    name: 'glob_files',
    description: '用 glob pattern 找文件. 例如 "**/*.test.ts". 只读操作, 无白名单限制.',
    parameters: { pattern: 'glob pattern (必填, e.g. "src/**/*.ts")' },
    execute: async (args) => {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) return { success: false, error: 'pattern 必填' };
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const pExecFile = promisify(execFile);
        const { stdout } = await pExecFile('find', [ctx.cwd, '-path', `*${pattern.replace(/\*\*\//, '*').replace(/\*\*$/, '*').replace(/\*$/, '*')}`, '-type', 'f'], { maxBuffer: 1024 * 1024 });
        const files = stdout.split('\n').filter(Boolean).slice(0, 100);
        const relFiles = files.map((f: string) => path.relative(ctx.cwd, f));
        return { success: true, output: `🔍 glob "${pattern}" 找到 ${relFiles.length} 个文件${relFiles.length === 100 ? ' (truncated)' : ''}:\n${relFiles.join('\n')}` };
      } catch (e: any) {
        return { success: false, error: `glob 失败: ${e.message}` };
      }
    }
  });

  ctx.tools.set('git_log', {
    name: 'git_log',
    description: '查看 git log. 默认 --oneline -10. 支持过滤和范围.',
    parameters: { range: '可选, e.g. "HEAD~5..HEAD" 或分支名', maxCount: '可选, 默认 10', oneline: '可选, "true" 用 --oneline (默认 true)' },
    execute: async (args) => {
      const range = String(args.range || '').trim();
      const maxCount = parseInt(String(args.maxCount || '10')) || 10;
      const oneline = String(args.oneline || 'true') === 'true';
      const argv = ['log'];
      if (oneline) argv.push('--oneline');
      if (maxCount > 0) argv.push(`-n`, String(maxCount));
      if (range) argv.push(range);
      const result = await shellExec('git', argv, { timeoutMs: 10_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      return { success: true, output: `📜 git log:\n${result.output || '(empty)'}` };
    }
  });

  ctx.tools.set('git_show', {
    name: 'git_show',
    description: '查看 commit 内容. 默认 HEAD. 支持 --stat 看统计, --patch 看 diff.',
    parameters: { ref: '可选, 默认 HEAD', stat: '可选, "true" 只看 stat (默认 false)' },
    execute: async (args) => {
      const ref = String(args.ref || 'HEAD').trim();
      const argv = ['show', ref];
      if (String(args.stat || 'false') === 'true') argv.push('--stat');
      const result = await shellExec('git', argv, { timeoutMs: 15_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      return { success: true, output: `📜 git show ${ref}:\n${result.output || '(empty)'}` };
    }
  });

  ctx.tools.set('git_stash', {
    name: 'git_stash',
    description: 'git stash 暂存当前未提交改动. action: save/pop/list/apply/drop. 支持 message.',
    parameters: { action: '动作 (必填)', message: '可选, save 时的描述', index: '可选, apply/pop/drop 的 stash index' },
    execute: async (args) => {
      const action = String(args.action || '').trim();
      if (!['save', 'pop', 'list', 'apply', 'drop'].includes(action)) {
        return { success: false, error: `action 必须是 save/pop/list/apply/drop 之一, 收到: ${action}` };
      }
      const argv = ['stash', action];
      if (action === 'save' && args.message) argv.push('-m', String(args.message));
      if ((action === 'apply' || action === 'drop' || action === 'pop') && args.index) {
        argv.push('stash@{' + String(args.index) + '}');
      }
      const result = await shellExec('git', argv, { timeoutMs: 10_000 });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error, output: result.output };
      return { success: true, output: `✅ git stash ${action}\n${result.output || ''}` };
    }
  });

  // 测试 & 类型检查
  ctx.tools.set('vitest_run', {
    name: 'vitest_run',
    description: '跑 vitest 测试. 自动 bail (失败就停). 默认 60s timeout.',
    parameters: { pattern: '可选, 文件 glob', timeoutMs: '可选, 默认 60000' },
    execute: async (args) => {
      const argv = ['vitest', 'run', '--reporter=default', '--no-color', '--bail=1'];
      if (args.pattern) argv.push(String(args.pattern));
      const timeoutMs = parseInt(String(args.timeoutMs || '60000')) || 60000;
      const result = await shellExec('npx', argv, { timeoutMs });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error || 'vitest 失败', output: result.output };
      return { success: true, output: `✅ vitest 通过:\n${(result.output || '').slice(0, 2000)}` };
    }
  });

  ctx.tools.set('tsc_check', {
    name: 'tsc_check',
    description: '跑 tsc --noEmit 检查 TypeScript 编译. 默认 60s timeout.',
    parameters: { project: '可选, tsconfig 路径 (默认 tsconfig.json)', timeoutMs: '可选, 默认 60000' },
    execute: async (args) => {
      const argv = ['tsc', '--noEmit'];
      if (args.project) argv.push('-p', String(args.project));
      else argv.push('-p', 'tsconfig.json');
      const timeoutMs = parseInt(String(args.timeoutMs || '60000')) || 60000;
      const result = await shellExec('npx', argv, { timeoutMs });
      if (result.deniedByGuard) return { success: false, error: result.error };
      if (!result.success) return { success: false, error: result.error || 'tsc 失败', output: result.output };
      return { success: true, output: `✅ tsc 通过:\n${(result.output || 'no errors').slice(0, 1000)}` };
    }
  });

  // Task 工具
  ctx.tools.set('create_task', {
    name: 'create_task',
    description: '创建一个新多步任务, 初始 steps 列表由 LLM 给出.',
    parameters: { goal: '任务目标 (必填)', steps: '步骤列表 (必填)', sessionKey: '可选', branch: '可选' },
    execute: async (args) => {
      const goal = String(args.goal || '').trim();
      const stepsRaw = args.steps;
      if (!goal) return { success: false, error: 'goal 必填' };
      let steps: string[] = [];
      if (Array.isArray(stepsRaw)) {
        steps = stepsRaw.map((s: any) => String(s).trim()).filter(Boolean);
      } else if (typeof stepsRaw === 'string') {
        steps = stepsRaw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
      }
      if (steps.length === 0) return { success: false, error: 'steps 必填且至少 1 步' };
      const sessionKey = String(args.sessionKey || '').trim() || undefined;
      const branch = String(args.branch || '').trim() || undefined;
      try {
        const { createTask } = await import('./task-state.js');
        const task = await createTask({ goal, steps, sessionKey, branch });
        return { success: true, output: `✅ task created: ${task.id}\nbranch: ${branch || '(未指定)'}\nsteps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` };
      } catch (e) {
        return { success: false, error: `create_task 失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('update_task', {
    name: 'update_task',
    description: '更新任务的某一步状态.',
    parameters: { task_id: '任务 id', step_id: '步骤 id', status: '新状态', result_summary: '可选', error: '可选' },
    execute: async (args) => {
      const taskId = String(args.task_id || '').trim();
      const stepId = String(args.step_id || '').trim();
      const status = String(args.status || '').trim() as any;
      if (!taskId || !stepId) return { success: false, error: 'task_id + step_id 必填' };
      if (!['running', 'done', 'failed', 'skipped'].includes(status)) {
        return { success: false, error: `status 必须是 running|done|failed|skipped` };
      }
      try {
        const { updateStep } = await import('./task-state.js');
        const patch: any = { status };
        if (args.result_summary) patch.resultSummary = String(args.result_summary);
        if (args.error) patch.error = String(args.error);
        const updated = await updateStep(taskId, stepId, patch);
        if (!updated) return { success: false, error: `任务 ${taskId} 未找到` };
        const nextRunning = updated.steps.find((s) => s.status === 'running');
        return {
          success: true,
          output: `✅ step ${stepId} → ${status}\ntask 状态: ${updated.status}${nextRunning ? `\n下一步: ${nextRunning.id} — ${nextRunning.description}` : ''}`,
        };
      } catch (e) {
        return { success: false, error: `update_task 失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('get_task', {
    name: 'get_task',
    description: '查任务的当前状态和步骤进度.',
    parameters: { task_id: '任务 id (必填)' },
    execute: async (args) => {
      const taskId = String(args.task_id || '').trim();
      if (!taskId) return { success: false, error: 'task_id 必填' };
      try {
        const { getTask } = await import('./task-state.js');
        const t = await getTask(taskId);
        if (!t) return { success: false, error: `任务 ${taskId} 未找到` };
        const lines = [
          `任务: ${t.id}`,
          `目标: ${t.goal}`,
          `状态: ${t.status}`,
          `branch: ${t.branch || '(未指定)'}`,
          `sessionKey: ${t.sessionKey || '(未指定)'}`,
          `创建: ${t.createdAt}`,
          `更新: ${t.updatedAt}`,
          ``,
          `步骤:`,
          ...t.steps.map((s: any) => `  ${s.status === 'done' ? '✅' : s.status === 'running' ? '🔄' : s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : '⏳'} ${s.id} — ${s.description}${s.resultSummary ? `\n     结果: ${s.resultSummary}` : ''}${s.error ? `\n     错误: ${s.error}` : ''}`),
        ];
        return { success: true, output: lines.join('\n') };
      } catch (e) {
        return { success: false, error: `get_task 失败: ${String(e)}` };
      }
    }
  });

  ctx.tools.set('list_tasks', {
    name: 'list_tasks',
    description: '列出最近 N 个任务 (默认 10).',
    parameters: { limit: '可选, 默认 10' },
    execute: async (args) => {
      const limit = Number(args.limit) || 10;
      try {
        const { listTasks } = await import('./task-state.js');
        const tasks = await listTasks(limit);
        if (tasks.length === 0) {
          return { success: true, output: '当前没有任务. 用 create_task 创建一个.' };
        }
        const lines = tasks.map((t: any) => {
          const done = t.steps.filter((s: any) => s.status === 'done').length;
          const total = t.steps.length;
          return `${t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄'} ${t.id} — ${t.goal} (${done}/${total} steps, branch: ${t.branch || '-'})`;
        });
        return { success: true, output: `最近 ${tasks.length} 个任务:\n${lines.join('\n')}` };
      } catch (e) {
        return { success: false, error: `list_tasks 失败: ${String(e)}` };
      }
    }
  });

  // ============================================================
  // 2026-07-10 双栖 agent 网络新增: goal handoff 工具
  // (park_goal / resume_goal / continue_goal_background)
  // 内部调用 goal-resume.ts, 错误不抛, 静默返回 error 字段
  // ============================================================

  ctx.tools.set('park_goal', {
    name: 'park_goal',
    description: '暂停当前目标并落盘快照. 切换 channel / 用户离开 / 等对端响应 / 推到对端 前必调. 接收 goalRef (含 goalId + targetId) + reason.',
    parameters: {
      goal_id: '已存在或新生成的 goal ID (建议 goal-${ts}-${rand} 格式)',
      target_id: '用户视角的稳定目标描述 (e.g. "完成财务模块迁移")',
      created_by: 'user | agent | peer',
      origin_channel: '当前 session / channel id',
      reason: 'channel_switch | user_away | awaiting_external | peer_handoff',
    },
    execute: async (args) => {
      try {
        const { parkGoal } = await import('./goal-resume.js');
        const handle = await parkGoal(
          {
            goalId: String(args.goal_id || '').trim(),
            targetId: String(args.target_id || '').trim(),
            createdBy: (args.created_by === 'user' || args.created_by === 'peer') ? args.created_by : 'agent',
            createdAt: new Date().toISOString(),
            originChannel: String(args.origin_channel || '').trim(),
          },
          (args.reason as 'channel_switch' | 'user_away' | 'awaiting_external' | 'peer_handoff') || 'channel_switch',
        );
        return { success: !handle.error, output: JSON.stringify(handle, null, 2), error: handle.error };
      } catch (e) {
        return { success: false, error: `park_goal 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('resume_goal', {
    name: 'resume_goal',
    description: '恢复一个 park 的目标. 加载末 30 条消息到 session + 关联 task 改 running. 切回 channel / 用户回来 / 收到对端 ack 时调.',
    parameters: {
      goal_id: 'park 时记的 goal ID',
      new_session: 'true = 在新 session key 下续, 默认 false (留原 session)',
      channel_id: '可选, 指定 channelId 恢复 (默认 = originChannel)',
    },
    execute: async (args) => {
      try {
        const { resumeGoal } = await import('./goal-resume.js');
        const newSessionStr = String(args.new_session || '').toLowerCase();
        const handle = await resumeGoal(String(args.goal_id || '').trim(), {
          newSession: newSessionStr === 'true' || newSessionStr === '1',
          channelId: args.channel_id ? String(args.channel_id) : undefined,
        });
        return { success: !handle.error, output: JSON.stringify(handle, null, 2), error: handle.error };
      } catch (e) {
        return { success: false, error: `resume_goal 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('continue_goal_background', {
    name: 'continue_goal_background',
    description: '把目标推到对端 peer 后台跑. 内部 park 本机 + P2P 推消息 + 隐私过滤 (judgment 不发). 任务大 / 想分工时用.',
    parameters: {
      goal_id: '当前 goal ID',
      target_id: '用户视角目标描述',
      origin_channel: '当前 session id',
      peer_did: '对端 DID (来自 list_peers)',
    },
    execute: async (args) => {
      try {
        const { continueGoalInBackground } = await import('./goal-resume.js');
        const peerDid = String(args.peer_did || '').trim();
        if (!peerDid) return { success: false, error: 'peer_did 必填' };

        // 注入 p2p 发送函数 — 通过 ctx.p2pNetwork 调用
        const p2pSendMessage = async (peerId: string, type: string, message: string) => {
          try {
            // p2pNetwork 在 ctx 里 (由 PiAgentSession 注入)
            const p2pNetwork = (ctx as any).p2pNetwork;
            if (!p2pNetwork || typeof p2pNetwork.sendMessage !== 'function') {
              return { success: false, error: 'p2pNetwork 未注入到 ctx' };
            }
            await p2pNetwork.sendMessage(peerId, type, message);
            return { success: true };
          } catch (e) {
            return { success: false, error: String(e).slice(0, 100) };
          }
        };

        const result = await continueGoalInBackground(
          {
            goalId: String(args.goal_id || '').trim(),
            targetId: String(args.target_id || '').trim(),
            createdBy: 'agent',
            createdAt: new Date().toISOString(),
            originChannel: String(args.origin_channel || '').trim(),
          },
          peerDid,
          p2pSendMessage,
        );
        return { success: !result.handle.error, output: JSON.stringify(result, null, 2), error: result.handle.error };
      } catch (e) {
        return { success: false, error: `continue_goal_background 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });
}

/**
 * 注册 Wallet + Polymarket + Safe 工具 (基于 constraint-runtime/src/tools/).
 */
export function registerWalletTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('wallet_create', {
    name: 'wallet_create',
    description: '创建新 EVM 钱包 (BIP-39 12 词助记词 + 私钥 + 地址).',
    parameters: {},
    execute: async () => {
      try {
        const { createWallet } = await import('../constraint-runtime/dist/tools/WalletTools/createWallet.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/createWallet.js'));
        const r = await createWallet();
        return { success: true, output: `✅ 钱包创建成功:\n  address: ${r.address}\n  privateKey: ${r.privateKey}\n  mnemonic: ${r.mnemonic}\n  createdAt: ${r.createdAt}` };
      } catch (e: any) {
        return { success: false, error: `创建失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_import', {
    name: 'wallet_import',
    description: '导入已有 EVM 钱包 (用助记词或私钥)',
    parameters: { mnemonic: '可选, 12/15/18/21/24 词助记词', privateKey: '可选, 0x 开头的私钥' },
    execute: async (args) => {
      try {
        const { importWallet } = await import('../constraint-runtime/dist/tools/WalletTools/importWallet.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/importWallet.js'));
        const r = await importWallet({ mnemonic: args.mnemonic, privateKey: args.privateKey });
        return { success: true, output: `✅ 钱包导入成功:\n  address: ${r.address}\n  privateKey: ${r.privateKey}\n  source: ${r.source}` };
      } catch (e: any) {
        return { success: false, error: `导入失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_get_balance', {
    name: 'wallet_get_balance',
    description: '查 EVM 钱包 ETH 余额.',
    parameters: { address: '0x 开头的 EVM 地址 (必填)', rpcUrl: '可选 RPC URL (默认 eth.llamarpc.com)' },
    execute: async (args) => {
      try {
        const { getBalance } = await import('../constraint-runtime/dist/tools/WalletTools/getBalance.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/getBalance.js'));
        const r = await getBalance({ address: String(args.address), rpcUrl: args.rpcUrl });
        return { success: true, output: `💰 ${r.address}\n  ${r.balanceEth} ${r.symbol} (${r.balance} wei)` };
      } catch (e: any) {
        return { success: false, error: `查余额失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_sign_message', {
    name: 'wallet_sign_message',
    description: '用私钥对消息做 EIP-191 personal_sign 签名',
    parameters: { message: '要签名的消息 (必填)', privateKey: '0x 开头的私钥 (必填)' },
    execute: async (args) => {
      try {
        const { signMessage } = await import('../constraint-runtime/dist/tools/WalletTools/signMessage.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/signMessage.js'));
        const r = await signMessage({ message: String(args.message), privateKey: String(args.privateKey) });
        return { success: true, output: `✅ 签名完成:\n  address: ${r.address}\n  message: ${r.message}\n  signature: ${r.signature}` };
      } catch (e: any) {
        return { success: false, error: `签名失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_send_tx', {
    name: 'wallet_send_tx',
    description: '用 EVM 钱包发送交易 (转账 ETH 或调用合约).',
    parameters: { privateKey: '私钥 (必填)', to: '接收地址 (必填)', value: '发送 wei 数量 (必填)', data: '可选 0x 开头的 calldata', rpcUrl: '可选 RPC URL' },
    execute: async (args) => {
      try {
        const { sendTransaction } = await import('../constraint-runtime/dist/tools/WalletTools/sendTransaction.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/sendTransaction.js'));
        const r = await sendTransaction({
          privateKey: String(args.privateKey),
          to: String(args.to),
          value: String(args.value),
          data: args.data ? String(args.data) : undefined,
          rpcUrl: args.rpcUrl,
        });
        return { success: true, output: `✅ 交易已发送:\n  hash: ${r.hash}\n  from: ${r.from} → to: ${r.to}\n  value: ${r.value} wei` };
      } catch (e: any) {
        return { success: false, error: `交易失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_transfer_token', {
    name: 'wallet_transfer_token',
    description: '用 EVM 钱包转 ERC20 token.',
    parameters: { privateKey: '私钥 (必填)', tokenAddress: 'ERC20 合约地址 (必填)', to: '接收地址 (必填)', amount: 'token 数量', decimals: '可选 token decimals', rpcUrl: '可选 RPC URL' },
    execute: async (args) => {
      try {
        const { transferToken } = await import('../constraint-runtime/dist/tools/WalletTools/transferToken.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/transferToken.js'));
        const r = await transferToken({
          privateKey: String(args.privateKey),
          tokenAddress: String(args.tokenAddress),
          to: String(args.to),
          amount: String(args.amount),
          decimals: args.decimals ? Number(args.decimals) : undefined,
          rpcUrl: args.rpcUrl,
        });
        return { success: true, output: `✅ Token 转账完成:\n  hash: ${r.hash}\n  ${r.amount} ${r.tokenAddress.substring(0, 10)}...` };
      } catch (e: any) {
        return { success: false, error: `转账失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('wallet_autopay', {
    name: 'wallet_autopay',
    description: '设置自动付款 (订阅/定期扣款, 用 SafeSDK 自动执行).',
    parameters: { from: '付款方地址 (必填)', to: '收款方地址 (必填)', amount: '金额 (必填)', interval: '周期 (e.g. daily/weekly/monthly)', token: '可选, 默认 ETH' },
    execute: async (args) => {
      try {
        const mod: any = await import('../constraint-runtime/dist/tools/WalletTools/autoPay.js').catch(() => import('../constraint-runtime/src/tools/WalletTools/autoPay.js'));
        const fn = mod.autoPay || mod.setAutoPay || mod.default;
        if (!fn) return { success: false, error: 'autoPay 接口未找到' };
        const r = await fn({
          from: String(args.from), to: String(args.to), amount: String(args.amount),
          interval: String(args.interval || 'monthly'), token: args.token,
        });
        return { success: true, output: `✅ 自动付款已设置: ${JSON.stringify(r)}` };
      } catch (e: any) {
        return { success: false, error: `设置失败: ${String(e.message || e)}` };
      }
    }
  });

  // Polymarket
  ctx.tools.set('polymarket_list_markets', {
    name: 'polymarket_list_markets',
    description: '列出 Polymarket 预测市场.',
    parameters: { limit: '可选 数量 (默认 50)', offset: '可选 偏移', closed: '可选 是否只显示已关闭' },
    execute: async (args) => {
      try {
        const { listMarkets } = await import('../constraint-runtime/dist/tools/PolymarketSDK/listMarkets.js').catch(() => import('../constraint-runtime/src/tools/PolymarketSDK/listMarkets.js'));
        const markets = await listMarkets({
          limit: args.limit ? Number(args.limit) : 50,
          offset: args.offset ? Number(args.offset) : 0,
          closed: args.closed ? String(args.closed) === 'true' : false,
        });
        if (!markets || markets.length === 0) {
          return { success: true, output: '📊 Polymarket 当前没有活跃市场' };
        }
        const lines = markets.slice(0, 10).map((m: any, i: number) => `  ${i + 1}. [${m.id}] ${m.question}`);
        return { success: true, output: `📊 Polymarket 找到 ${markets.length} 个市场 (前 10):\n${lines.join('\n')}` };
      } catch (e: any) {
        return { success: false, error: `查询失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('polymarket_get_market', {
    name: 'polymarket_get_market',
    description: '获取单个 Polymarket 市场的详情.',
    parameters: { marketId: '市场 ID (必填)' },
    execute: async (args) => {
      try {
        const mod: any = await import('../constraint-runtime/dist/tools/PolymarketSDK/getMarket.js').catch(() => import('../constraint-runtime/src/tools/PolymarketSDK/getMarket.js'));
        const fn = mod.getMarket || mod.default;
        const m: any = await fn(String(args.marketId));
        if (!m) return { success: false, error: '市场不存在' };
        return { success: true, output: `📊 市场详情:\n  ${JSON.stringify(m, null, 2).substring(0, 1500)}` };
      } catch (e: any) {
        return { success: false, error: `查询失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('polymarket_get_orders', {
    name: 'polymarket_get_orders',
    description: '查询 Polymarket 开放订单. 需要钱包私钥 privateKey 做 API key 鉴权.',
    parameters: {
      privateKey: '钱包私钥 0x... (必填)',
      marketId: '可选 按市场 ID 过滤',
      apiKey: '可选, 已存在的 API key',
      apiSecret: '可选, API secret',
      apiPassphrase: '可选, API passphrase',
      funder: '可选, 资金地址',
    },
    execute: async (args) => {
      try {
        const { getOrders } = await import('../constraint-runtime/dist/tools/PolymarketSDK/getOrders.js').catch(() => import('../constraint-runtime/src/tools/PolymarketSDK/getOrders.js'));
        const orders = await getOrders({
          privateKey: String(args.privateKey),
          marketId: args.marketId ? String(args.marketId) : undefined,
          apiKey: args.apiKey ? String(args.apiKey) : undefined,
          apiSecret: args.apiSecret ? String(args.apiSecret) : undefined,
          apiPassphrase: args.apiPassphrase ? String(args.apiPassphrase) : undefined,
          funder: args.funder ? String(args.funder) : undefined,
        });
        return { success: true, output: `📋 订单列表: ${JSON.stringify(orders, null, 2).substring(0, 1500)}` };
      } catch (e: any) {
        return { success: false, error: `查询失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('polymarket_create_order', {
    name: 'polymarket_create_order',
    description: '在 Polymarket 下单 (BUY/SELL). 需要钱包私钥 privateKey 做 EIP-712 订单签名与 API key 派生.',
    parameters: {
      privateKey: '下单钱包私钥 0x... (必填)',
      marketId: '市场 ID (必填)',
      side: 'BUY 或 SELL (必填)',
      price: '价格 0-1 (必填, 需符合 tickSize)',
      size: '数量 USDC (必填)',
      outcome: '可选, Yes/No 或索引 0/1, 默认第一个 (通常 Yes)',
      tokenId: '可选, 显式条件代币 tokenID (优先于 outcome)',
      orderType: '可选, GTC (默认) 或 GTD',
      apiKey: '可选, 已存在的 API key (需配合 apiSecret/apiPassphrase)',
      apiSecret: '可选, API secret',
      apiPassphrase: '可选, API passphrase',
      funder: '可选, 资金地址 (默认=私钥地址)',
    },
    execute: async (args) => {
      try {
        const { createOrder } = await import('../constraint-runtime/dist/tools/PolymarketSDK/createOrder.js').catch(() => import('../constraint-runtime/src/tools/PolymarketSDK/createOrder.js'));
        const r: any = await createOrder({
          privateKey: String(args.privateKey),
          marketId: String(args.marketId),
          side: String(args.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: Number(args.price),
          size: Number(args.size),
          outcome: args.outcome !== undefined ? args.outcome : undefined,
          tokenId: args.tokenId ? String(args.tokenId) : undefined,
          orderType: args.orderType ? String(args.orderType) as 'GTC' | 'GTD' : undefined,
          apiKey: args.apiKey ? String(args.apiKey) : undefined,
          apiSecret: args.apiSecret ? String(args.apiSecret) : undefined,
          apiPassphrase: args.apiPassphrase ? String(args.apiPassphrase) : undefined,
          funder: args.funder ? String(args.funder) : undefined,
        });
        if (r.success) return { success: true, output: `✅ 订单已提交: orderId=${r.orderId} status=${r.status}` };
        return { success: false, error: r.message, output: r.message };
      } catch (e: any) {
        return { success: false, error: `下单失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('polymarket_cancel_order', {
    name: 'polymarket_cancel_order',
    description: '取消 Polymarket 订单. 需要钱包私钥 privateKey 做 API key 鉴权.',
    parameters: {
      privateKey: '钱包私钥 0x... (必填)',
      orderId: '订单 ID (必填)',
      apiKey: '可选, 已存在的 API key',
      apiSecret: '可选, API secret',
      apiPassphrase: '可选, API passphrase',
      funder: '可选, 资金地址',
    },
    execute: async (args) => {
      try {
        const { cancelOrder } = await import('../constraint-runtime/dist/tools/PolymarketSDK/cancelOrder.js').catch(() => import('../constraint-runtime/src/tools/PolymarketSDK/cancelOrder.js'));
        const r = await cancelOrder({
          privateKey: String(args.privateKey),
          orderId: String(args.orderId),
          apiKey: args.apiKey ? String(args.apiKey) : undefined,
          apiSecret: args.apiSecret ? String(args.apiSecret) : undefined,
          apiPassphrase: args.apiPassphrase ? String(args.apiPassphrase) : undefined,
          funder: args.funder ? String(args.funder) : undefined,
        });
        if (r.success) return { success: true, output: `✅ 取消订单: ${r.message}` };
        return { success: false, error: r.message, output: r.message };
      } catch (e: any) {
        return { success: false, error: `取消失败: ${String(e.message || e)}` };
      }
    }
  });

  // ============================================================
  // x402 协议 — 智能体自动支付工作流 (2026-07-24)
  // 基于 @x402/core + @x402/evm + @x402/fetch + @x402/mcp 协议栈
  // ============================================================

  ctx.tools.set('x402_pay', {
    name: 'x402_pay',
    description: '低级钱包付款: 用私钥直接转 ETH/USDC。标准 x402 资源访问请优先用 x402_fetch。',
    parameters: {
      privateKey: '钱包私钥 0x... (必填)',
      amount: '金额 (ETH 或 USDC 数量, 必填)',
      to: '收款方地址 0x... (必填)',
      network: '网络: base | base-sepolia | mainnet | sepolia (默认 base-sepolia)',
      currency: '代币: ETH | USDC (默认 ETH)',
      memo: '支付说明 (可选)',
    },
    execute: async (args) => {
      try {
        const { x402Pay, decryptChannelWallet } = await import('./x402/x402Pay.js');
        let privateKey = args.privateKey ? String(args.privateKey) : undefined;
        if (!privateKey && ctx.getChannelWallet) {
          const wallet = await ctx.getChannelWallet();
          if (wallet && wallet.autoPayEnabled) {
            const decrypted = await decryptChannelWallet(
              { encryptedPrivateKey: wallet.encryptedPrivateKey, encryptedPrivateKeyIv: wallet.encryptedPrivateKeyIv, walletAddress: wallet.walletAddress },
              wallet.did
            );
            if (decrypted) privateKey = decrypted.privateKey;
          }
        }
        if (!privateKey) {
          return { success: false, error: '未提供 privateKey 且 channel 未绑定自动支付钱包' };
        }
        const r = await x402Pay({
          privateKey,
          amount: String(args.amount),
          to: String(args.to),
          network: args.network ? String(args.network) : undefined,
          currency: args.currency ? String(args.currency) : undefined,
          memo: args.memo ? String(args.memo) : undefined,
        });
        if (!r.success) return { success: false, error: r.error };
        return { success: true, output: `✅ x402 支付成功:\n  txHash: ${r.txHash}\n  paid: ${r.paid}\n  to: ${r.to}\n  network: ${r.network}` };
      } catch (e: any) {
        return { success: false, error: `x402_pay 失败: ${String(e.message || e)}` };
      }
    },
  });

  ctx.tools.set('x402_fetch', {
    name: 'x402_fetch',
    description: 'x402 Fetch — 自动化的 "请求→检测 402 → 钱包支付 → 重试" 循环。无需手动处理 402 支付流程。',
    parameters: {
      url: '目标 URL (必填)',
      method: 'HTTP method: GET | POST | PUT | DELETE (默认 GET)',
      body: '请求体 (可选)',
      headers: 'JSON 对象格式的额外 headers (可选)',
      privateKey: '钱包私钥 0x... (可选, 不提供时遇到 402 会提示需支付)',
      network: '限定可支付网络: base | base-sepolia | mainnet | sepolia (可选)',
      rpcUrl: '自定义 RPC URL (可选)',
    },
    execute: async (args) => {
      try {
        const { x402Fetch, decryptChannelWallet } = await import('./x402/x402Pay.js');
        let privateKey = args.privateKey ? String(args.privateKey) : undefined;
        if (!privateKey && ctx.getChannelWallet) {
          const wallet = await ctx.getChannelWallet();
          if (wallet && wallet.autoPayEnabled) {
            const decrypted = await decryptChannelWallet(
              { encryptedPrivateKey: wallet.encryptedPrivateKey, encryptedPrivateKeyIv: wallet.encryptedPrivateKeyIv, walletAddress: wallet.walletAddress },
              wallet.did
            );
            if (decrypted) privateKey = decrypted.privateKey;
          }
        }
        const headers = args.headers ? (typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers) : undefined;
        const r = await x402Fetch({
          url: String(args.url),
          method: args.method ? String(args.method) : undefined,
          body: args.body ? String(args.body) : undefined,
          headers,
          privateKey,
          network: args.network ? String(args.network) : undefined,
          rpcUrl: args.rpcUrl ? String(args.rpcUrl) : undefined,
        });
        if (!r.success) return { success: false, error: r.error, output: r.data ? JSON.stringify(r.data).substring(0, 1000) : undefined };
        const paymentLine = r.paymentInfo?.rawHeader ? `\n  [x402 payment-response] ${r.paymentInfo.rawHeader.substring(0, 160)}` : '';
        return {
          success: true,
          output: `✅ x402 fetch 完成 (status=${r.status})${paymentLine}\n${JSON.stringify(r.data, null, 2).substring(0, 2000)}`,
        };
      } catch (e: any) {
        return { success: false, error: `x402_fetch 失败: ${String(e.message || e)}` };
      }
    },
  });

  ctx.tools.set('x402_request_payment', {
    name: 'x402_request_payment',
    description: 'x402 服务端: 生成 HTTP 402 PaymentRequired 响应信息。用于智能体作为服务端时告知调用方需支付。',
    parameters: {
      price: '价格 (数字, 必填)',
      payTo: '收款方地址 0x... (必填)',
      currency: '代币: USDC | ETH (默认 USDC)',
      network: '网络: base | base-sepolia (默认 base)',
      resourceDescription: '资源描述 (可选)',
    },
    execute: async (args) => {
      try {
        const { x402RequestPayment } = await import('./x402/x402Pay.js');
        const r = x402RequestPayment({
          price: Number(args.price),
          payTo: String(args.payTo),
          currency: args.currency ? String(args.currency) : undefined,
          network: args.network ? String(args.network) : undefined,
          resourceDescription: args.resourceDescription ? String(args.resourceDescription) : undefined,
        });
        return {
          success: true,
          output: `🛡️ 402 Payment Required:\n  金额: ${args.price} ${args.currency || 'USDC'}\n  网络: ${args.network || 'base'}\n  收款: ${args.payTo}\n  描述: ${args.resourceDescription || '(无)'}\n\nHTTP 响应模板:\n  statusCode: ${r.statusCode}\n  headers: ${JSON.stringify(r.headers, null, 2)}\n  body: ${r.body}`,
        };
      } catch (e: any) {
        return { success: false, error: `x402_request_payment 失败: ${String(e.message || e)}` };
      }
    },
  });

  ctx.tools.set('x402_check_balance', {
    name: 'x402_check_balance',
    description: '查 EVM 地址余额，判断是否足够支付 x402 费用。',
    parameters: {
      address: 'EVM 地址 0x... (必填)',
      network: '网络: base | base-sepolia | mainnet | sepolia (默认 base-sepolia)',
      rpcUrl: '自定义 RPC URL (可选)',
    },
    execute: async (args) => {
      try {
        const { x402CheckBalance } = await import('./x402/x402Pay.js');
        const r = await x402CheckBalance({
          address: String(args.address),
          network: args.network ? String(args.network) : undefined,
          rpcUrl: args.rpcUrl ? String(args.rpcUrl) : undefined,
        });
        if (!r.success) return { success: false, error: r.error };
        return { success: true, output: `💰 地址 ${args.address}\n  余额: ${r.balance} ETH\n  网络: ${r.network}` };
      } catch (e: any) {
        return { success: false, error: `x402_check_balance 失败: ${String(e.message || e)}` };
      }
    },
  });

  // Safe
  ctx.tools.set('safe_deploy', {
    name: 'safe_deploy',
    description: '部署 Safe 多签钱包.',
    parameters: { owners: 'JSON 数组 owner 地址 (必填)', threshold: '需要几个签名 (必填)' },
    execute: async (args) => {
      try {
        const { deploySafe } = await import('../constraint-runtime/dist/tools/SafeSDK/deploySafe.js').catch(() => import('../constraint-runtime/src/tools/SafeSDK/deploySafe.js'));
        const owners = Array.isArray(args.owners) ? args.owners : JSON.parse(String(args.owners));
        const r = await deploySafe({ owners, threshold: Number(args.threshold) });
        return { success: true, output: `✅ Safe 部署: ${JSON.stringify(r)}` };
      } catch (e: any) {
        return { success: false, error: `部署失败: ${String(e.message || e)}` };
      }
    }
  });

  // 2026-07-28: 注册 LSP 工具 (代码智能)
  // registerBuiltinTools 不是 async, 用同步 import 兜底
  try {
    // 动态 import + 立即执行, 兼容 ESM
    import('../lsp/lsp-tools.js').then(({ registerLspTools }) => {
      registerLspTools(ctx);
    }).catch((e) => {
      console.warn('[registerTools] LSP 工具注册失败 (非致命):', e);
    });
  } catch (lspErr) {
    console.warn('[registerTools] LSP 工具注册失败 (非致命):', lspErr);
  }
}

/**
 * 监听 P2P 消息 (远端 + 本地 inbox bus), 把消息存到 _inboxMessages 供 check_inbox 读.
 * 失败静默, 不阻塞 PiAgentSession 构造.
 */
export function setupInboxListener(ctx: ToolRegistryContext): void {
  try {
    p2pNetwork.onMessage('*', (msg: Uint8Array, from: string, did?: string) => {
      try {
        const text = new TextDecoder().decode(msg);
        let type = 'message';
        let payload = text;
        if (text.startsWith('DID:')) {
          const pipeIdx = text.indexOf('|');
          if (pipeIdx > 0) {
            const rest = text.substring(pipeIdx + 1);
            const colonIdx = rest.indexOf(':');
            if (colonIdx > 0) {
              type = rest.substring(0, colonIdx);
              payload = rest.substring(colonIdx + 1);
            } else {
              type = rest;
              payload = '';
            }
          }
        } else {
          const colonIdx = text.indexOf(':');
          if (colonIdx > 0) {
            type = text.substring(0, colonIdx);
            payload = text.substring(colonIdx + 1);
          }
        }
        ctx._inboxMessages.push({
          id: `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          from: from.substring(0, 32),
          fromDid: did,
          type,
          payload,
          timestamp: Date.now(),
          source: 'p2p',
        });
        if (ctx._inboxMessages.length > 1000) {
          ctx._inboxMessages.splice(0, ctx._inboxMessages.length - 1000);
        }
      } catch (err) {
        console.warn('[PiAgent] inbox listener decode error:', err);
      }
    });
  } catch (err) {
    console.warn('[PiAgent] setupInboxListener (p2pNetwork) failed (non-fatal):', err);
  }

  try {
    const { LocalInboxBus } = require('../network/local-inbox-bus.js');
    const myRole = process.env.BOLLOON_ROLE || 'default';
    LocalInboxBus.getInstance().subscribe(myRole, (msg: any) => {
      ctx._inboxMessages.push({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: msg.from || 'unknown',
        fromDid: msg.fromDid,
        type: msg.type || 'agent-local-message',
        payload: msg.payload || '',
        timestamp: msg.timestamp || Date.now(),
        source: 'local',
      });
      if (ctx._inboxMessages.length > 1000) {
        ctx._inboxMessages.splice(0, ctx._inboxMessages.length - 1000);
      }
    });
  } catch (err) {
    // LocalInboxBus 可能还没创建, 不阻塞
  }
}

/**
 * M3.3: 工具结果缓存 — 防止 loop 重试时副作用 (写文件 / 改代码) 执行多次.
 * 5 分钟 TTL, 容量 200, 只缓存 success 结果.
 */
export class IdempotencyCache {
  private cache: Map<string, { result: any; ts: number }> = new Map();
  private readonly TTL_MS = 5 * 60 * 1000;
  private readonly MAX = 200;

  wrap(tools: Map<string, Tool>): void {
    for (const [name, tool] of tools.entries()) {
      if (!SIDE_EFFECT_TOOLS.has(name)) continue;
      const original = tool.execute;
      tool.execute = async (args: any) => {
        const key = `${name}|${JSON.stringify(args)}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.ts < this.TTL_MS) {
          return { ...cached.result, output: (cached.result.output || '') + '\n[↻ idempotency cache hit]' };
        }
        const result = await original(args);
        if (result && result.success) {
          if (this.cache.size >= this.MAX) {
            this.cache.clear();
          }
          this.cache.set(key, { result, ts: Date.now() });
        }
        return result;
      };
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
