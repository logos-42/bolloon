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
  'create_task', 'update_task', 'terminal', 'process',
]);

/**
 * 2026-08-12 (Task2): 统一终端执行入口 — shell_exec 与 terminal 共用.
 * 输入可以是单条命令字符串 (raw) 或命令数组 (commands, 并行执行).
 * 护栏 checkTerminalCommand (denylist-only): 只挡高危破坏模式, 其余灵活放行.
 */
export interface RunTerminalOptions {
  cwd?: string;
  timeoutMs?: number;
  /** 多条命令 (并行执行), 每条独立字符串. 优先于 raw. */
  commands?: string[];
  /** 2026-08-12 (TaskD): background=true 后台执行 (立即返回 session_id, 不阻塞). 用 process 工具 poll/wait/kill. */
  background?: boolean;
}

/** 2026-08-12 (TaskA): 探测可用的命令 (跨平台: Windows 无 python3, 有 python). 返回 [cmd, ...] 或 null. */
async function detectRunner(candidates: string[]): Promise<string[] | null> {
  const { spawn } = await import('child_process');
  for (const c of candidates) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(c, ['--version'], { stdio: 'ignore', windowsHide: true });
        p.on('close', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
      });
      if (ok) return [c];
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 2026-08-12 (TaskA): 自动识别代码块并在终端执行 — 便捷代码运行能力.
 * 接受 {code, language} → 写临时脚本文件 → 用对应解释器执行 (带超时/输出截断).
 * 语言映射: python/python3→python3/python, js/javascript/node→node, ts/typescript→tsx, shell/bash/sh→shell, 其他默认按文本.
 * 依赖注入: 写脚本目录 (默认 os.tmpdir), 便于测试.
 */
export interface RunCodeOptions {
  code: string;
  language?: string;
  timeoutMs?: number;
  cwd?: string;
  tmpDir?: string;
}
export async function runCodeSnippet(opts: RunCodeOptions): Promise<any> {
  const code = String(opts.code ?? '').trim();
  if (!code) return { success: false, error: 'code 必填' };
  const lang = String(opts.language || '').trim().toLowerCase();
  // 语言 → (扩展名, 解释器命令)
  const ext = lang === 'python' || lang === 'py' ? 'py'
    : lang === 'javascript' || lang === 'js' || lang === 'node' ? 'js'
    : lang === 'typescript' || lang === 'ts' ? 'ts'
    : lang === 'shell' || lang === 'bash' || lang === 'sh' ? 'sh'
    : lang === 'html' ? 'html'
    : 'txt';
  const runner = lang === 'python' || lang === 'py' ? await detectRunner(['python3', 'python'])
    : lang === 'javascript' || lang === 'js' || lang === 'node' ? await detectRunner(['node'])
    : lang === 'typescript' || lang === 'ts' ? ['npx', 'tsx']
    : lang === 'shell' || lang === 'bash' || lang === 'sh' ? ['bash']
    : null;
  if (!runner) {
    if (['python', 'py', 'js', 'javascript', 'node', 'ts', 'typescript', 'shell', 'bash', 'sh'].includes(lang)) {
      return { success: false, error: `解释器未找到 (${lang}), 请装对应运行时或改用 command` };
    }
    return { success: false, error: `不支持的语言 '${lang}', 支持: python/js/ts/shell/html` };
  }
  const { tmpdir } = await import('os');
  const tmpDir = opts.tmpDir ?? tmpdir();
  const file = `${tmpDir}/bolloon-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fsMod = await import('fs/promises');
  await fsMod.writeFile(file, code, 'utf-8');
  try {
    const { spawn } = await import('child_process');
    const timeoutMs = opts.timeoutMs ?? 30000;
    const result = await new Promise<any>((resolve) => {
      const proc = spawn(runner[0], [...runner.slice(1), file], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 忽略 */ }
        resolve({ success: false, error: `代码执行超时 (>${timeoutMs}ms)`, output: (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim().slice(0, 8000) });
      }, timeoutMs);
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: `启动失败: ${e.message}` }); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim().slice(0, 8000) || '(无输出)';
        resolve({ success: code === 0, output, exitCode: code, language: lang, script: file });
      });
    });
    return result;
  } finally {
    await fsMod.rm(file, { force: true }).catch(() => {});
  }
}

export async function runTerminalCommand(raw: string, opts: RunTerminalOptions = {}): Promise<any> {
  const { checkTerminalCommand } = await import('./shell-guard.js');
  const timeoutMs = opts.timeoutMs ?? 30000;
  const list = (opts.commands && opts.commands.length > 0) ? opts.commands : [raw];
  for (const c of list) {
    const guard = checkTerminalCommand(String(c || '').trim());
    if (!guard.allowed) {
      return { success: false, error: `[terminal-guard] ${guard.reason}`, deniedByGuard: true };
    }
  }
  // 2026-08-12 (TaskD): 后台执行 — 长命令不阻塞对话.
  if (opts.background) {
    const cmdStr = list.join(' && ');
    const { spawnBackground } = await import('./process-runner.js');
    const session = spawnBackground(cmdStr, opts.cwd ?? process.cwd());
    return {
      success: true,
      background: true,
      sessionId: session.id,
      cmd: cmdStr.slice(0, 200),
      message: `已在后台启动 (${session.id}). 用 process 工具轮询/等待: process(session_id="${session.id}", action="poll"|"wait"|"kill")`,
    };
  }
  const { exec } = await import('child_process');
  const runOne = (cmdStr: string): Promise<any> => new Promise((resolve) => {
    exec(cmdStr, {
      cwd: opts.cwd ?? process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const output = ((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '')).trim().slice(0, 8000);
      if (err) {
        resolve({ success: false, cmd: cmdStr.slice(0, 120), error: `exit ${err.code ?? '?'}: ${String(err.message || '').slice(0, 200)}`, output: output || undefined });
      } else {
        resolve({ success: true, cmd: cmdStr.slice(0, 120), output: output || '(无输出)' });
      }
    });
  });
  if (list.length === 1) return runOne(list[0]);
  const results = await Promise.all(list.map((c) => runOne(c)));
  const failed = results.filter((r) => !r.success);
  const allOutput = results.map((r) => `${r.cmd}\n${r.output || r.error || ''}`).join('\n\n---\n\n');
  if (failed.length > 0) {
    return { success: false, error: `${failed.length}/${list.length} 条命令失败: ${failed[0].error}`, output: allOutput, partial: results };
  }
  return { success: true, output: allOutput, count: list.length, parallel: true };
}

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

  // 2026-08-02: 远端 channel 工具 — 让本地智能体能获取远端 channel 列表 + 发送消息到远端
  //   (之前本地智能体看不到远端 channel, 无法 @ 远程智能体交流 — "工具没有给到位")
  ctx.tools.set('list_remote_channels', {
    name: 'list_remote_channels',
    description: '列出 P2P 好友节点分享给你的远端 channel (远程智能体会话). 每个远端 channel 属于某个 peer, 你可以在回复中写 "@渠道名 消息内容" 或调用 send_to_remote_channel 给它们发消息.',
    parameters: {},
    execute: async () => {
      try {
        const port = process.env.PORT || '54188';
        const res = await fetch(`http://127.0.0.1:${port}/api/remote-channels`);
        if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const peers = data?.peers || [];
        const lines: string[] = [];
        let total = 0;
        for (const p of peers) {
          const chs = p.channels || [];
          total += chs.length;
          if (chs.length === 0) continue;
          lines.push(`👤 ${p.peerName || ('peer-' + String(p.peerId).substring(0, 8))} (${String(p.peerId).substring(0, 16)}…):`);
          for (const c of chs) {
            lines.push(`  - @${c.name} (id=${c.id})`);
          }
        }
        if (total === 0) {
          return { success: true, output: '📭 当前没有远端 channel (没有好友分享 channel 给你, 或对方不在线). 可先用 add_friend_by_id 添加好友.' };
        }
        return { success: true, output: `🌐 ${total} 个远端 channel:\n${lines.join('\n')}\n\n在回复中写 "@渠道名 消息内容" 即可发送 (系统自动转发到对方节点).` };
      } catch (e: any) {
        return { success: false, error: `获取远端 channel 失败: ${String(e.message || e)}` };
      }
    }
  });

  ctx.tools.set('send_to_remote_channel', {
    name: 'send_to_remote_channel',
    description: '发送消息到远端 channel (远程智能体会话, 属于某个 P2P 好友节点). 对方节点会在该 channel 上跑 LLM 处理你的消息并回复. 用 list_remote_channels 查看可用 channel 和 owner.',
    parameters: {
      targetPublicKey: '远端节点 publicKey (64 hex, 用 list_remote_channels 看 owner)',
      channelId: '远端 channel id (用 list_remote_channels 查看)',
      text: '消息内容 (必填)',
      autoInvokeTools: '可选, 是否允许对方调用工具 (true/false, 默认 true)'
    },
    execute: async (args) => {
      const targetPublicKey = String(args.targetPublicKey || '').trim();
      const channelId = String(args.channelId || '').trim();
      const text = String(args.text || '').trim();
      if (!targetPublicKey || !channelId || !text) {
        return { success: false, error: 'targetPublicKey, channelId, text 必填 (用 list_remote_channels 查)' };
      }
      try {
        const port = process.env.PORT || '54188';
        const res = await fetch(`http://127.0.0.1:${port}/api/remote-channels/chat-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetPublicKey,
            channelId,
            text,
            ...(typeof args.autoInvokeTools === 'boolean' ? { autoInvokeTools: args.autoInvokeTools } : {}),
          })
        });
        const data = await res.json();
        if (!res.ok) {
          return { success: false, error: `发送失败: ${data.error || `HTTP ${res.status}`}` };
        }
        return { success: true, output: `📨 消息已发送到远端 channel ${channelId} (${data.sent ? '已送达' : data.queued ? '对方不在线, 已入队, 上线后自动送达' : '未知状态'}). 对方智能体会回复, 可用 check_inbox 或稍后查看.` };
      } catch (e: any) {
        return { success: false, error: `发送失败: ${String(e.message || e)}` };
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
        // 2026-08-11: 委派句柄 — ownerDid 绑当前 agent DID (防跨 channel 使用),
        // correlationId 幂等去重 (同一 agent 重复 correlation 只应出现一次)
        const ownerDid = ctx.identity?.did || 'unknown';
        const correlationId = `delegate:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
        const result = await delegateToEngine(engine, prompt, {
          cwd: cwd || undefined,
          ...(model ? { model } : {}),
          ownerDid,
          correlationId,
        });
      if (!result.success) {
        return { success: false, error: result.error, output: result.output };
      }
      const handleLine = result.handle
        ? `\n[delegate handle] contractVersion=${result.handle.contractVersion} delegateId=${result.handle.delegateId} ownerDid=${result.handle.ownerDid} correlationId=${result.handle.correlationId ?? '-'} capability=${result.handle.capability.slice(0, 16)}...`
        : '';
      return {
        success: true,
        output: `🤖 ${engine} 执行结果 (exitCode=${result.exitCode}):\n${result.output || '(无输出)'}${handleLine}`
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

  // 2026-08-12 (Task2): shell_exec / terminal 统一走模块级 runTerminalCommand (宽松护栏 + 多命令并行).

  // shell_exec — 2026-08-12 (Task2): 与 terminal 统一走宽松护栏 (denylist-only).
  //   兼容旧格式 (command + args 数组), 内部转成完整命令字符串交给 runTerminal,
  //   不再用窄白名单 → 模型不会因 "command 不在白名单" 报错.
  ctx.tools.set('shell_exec', {
    name: 'shell_exec',
    description: '执行 shell 命令 (兼容模式, 参数数组或命令字符串均可). 护栏只挡高危破坏操作 (sudo/格式化/rm -rf 根目录/写 ~/.bolloon 数据). 推荐直接用 terminal 传完整命令字符串.',
    parameters: { command: '可执行文件 或 完整命令 (必填)', args: '参数数组, 逗号分隔 (可选)', timeoutMs: '超时毫秒, 默认 30000' },
    execute: async (args) => {
      const cmd = String(args.command || '').trim();
      if (!cmd) return { success: false, error: 'command 必填' };
      // 兼容参数数组 → 拼成命令字符串
      let full = cmd;
      const rawArgs = args.args;
      let argList: string[] = [];
      if (Array.isArray(rawArgs)) {
        argList = rawArgs.map((s: any) => String(s).trim()).filter(Boolean);
      } else if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) argList = parsed.map((s: any) => String(s).trim()).filter(Boolean);
          } catch { /* 非 JSON 数组 */ }
        }
        if (argList.length === 0) argList = trimmed.split(',').map(s => s.trim()).filter(Boolean);
      }
      // 若 command 只是可执行文件名且带 args → 拼成 "cmd arg1 arg2"; 否则原样
      if (argList.length > 0 && !/\s/.test(cmd) && !cmd.includes('&&') && !cmd.includes(';') && !cmd.includes('|')) {
        full = `${cmd} ${argList.map(a => (/[\s"&|<>^()%!`]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')}`;
      }
      const timeoutMs = Number(args.timeoutMs) || 30000;
      return await runTerminalCommand(full, { timeoutMs, cwd: ctx.cwd });
    }
  });

  // 2026-08-10: terminal — 灵活终端写命令 (用户要求: bolloon 自己写命令进 terminal, 少围栏).
  //   2026-08-12 (Task2): 支持 commands 数组并行执行; 与 shell_exec 统一走 runTerminalCommand.
  //   与 shell_exec 的区别: 直接接受完整 shell 命令字符串, 更适合模型自主写命令.
  ctx.tools.set('terminal', {
    name: 'terminal',
    description: '执行完整 shell 命令 (支持管道/重定向/写文件/跑脚本). 护栏只挡高危破坏操作 (sudo/格式化/rm -rf 根目录/写 ~/.bolloon 数据), 其余灵活放行. 适合: 写 HTML 文件、跑 python/node 脚本、查系统状态、装依赖. 多条命令用 commands 数组并行执行. 长命令 (服务器/构建/后台任务) 设 background=true 后台执行不阻塞对话. 也可直接传 code+language 自动写脚本执行 (便捷代码运行: python/js/ts/shell/html).',
    parameters: { command: '完整 shell 命令 (可选, 如: echo "<html>" > /tmp/site/index.html && ls /tmp/site)', commands: '可选: 多条命令数组 (并行执行), 每条独立字符串', code: '可选: 一段代码, 传 code+language 时自动写脚本执行 (便捷代码运行)', language: '可选: code 的语言 (python/js/ts/shell/html), 默认自动', timeoutMs: '超时毫秒, 默认 30000', background: '可选: true 后台执行, 立即返回 session_id (用 process 工具 poll/wait/kill)' },
    execute: async (args) => {
      const timeoutMs = Number(args.timeoutMs) || 30000;
      // 便捷代码运行: 传 code → 自动写脚本执行
      const code = String(args.code ?? '').trim();
      if (code) {
        const lang = String(args.language || '').trim().toLowerCase();
        return await runCodeSnippet({ code, language: lang, timeoutMs, cwd: ctx.cwd });
      }
      const raw = String(args.command || '').trim();
      const commands = Array.isArray(args.commands) ? args.commands.map((c: any) => String(c || '').trim()).filter(Boolean) : [];
      if (!raw && commands.length === 0) return { success: false, error: 'command/code/commands 至少一个必填' };
      return await runTerminalCommand(raw, { timeoutMs, cwd: ctx.cwd, commands: commands.length > 0 ? commands : undefined, background: String(args.background).toLowerCase() === 'true' });
    }
  });

  // 2026-08-12 (TaskD): process — 后台进程管理 (学 hermes terminal background session + poll/wait/kill).
  //   长命令不阻塞对话: terminal(background=true) 启动 → process 工具轮询/等待/终止.
  ctx.tools.set('process', {
    name: 'process',
    description: '管理后台进程 (terminal background=true 启动的). action: poll(查状态, 不阻塞) / wait(等结束, 最多 timeoutMs) / kill(终止) / list(列全部). 长期运行命令的阻塞问题用它解决.',
    parameters: { session_id: '后台进程 session_id (必填, poll/wait/kill 用)', action: 'poll | wait | kill | list (默认 poll)', timeoutMs: 'wait 模式等待上限毫秒, 默认 30000' },
    execute: async (args) => {
      const action = String(args.action || 'poll').trim().toLowerCase();
      try {
        const { pollSession, waitSession, killSession, listSessions, isValidSessionId } = await import('./process-runner.js');
        if (action === 'list') {
          const all = listSessions();
          return { success: true, output: all.length === 0 ? '(无后台进程)' : all.map((s) => `  [${s.status}] ${s.id} ${s.cmd}`).join('\n') };
        }
        const sid = String(args.session_id || '').trim();
        if (!sid) return { success: false, error: 'session_id 必填' };
        if (!isValidSessionId(sid)) return { success: false, error: 'session_id 非法' };
        if (action === 'kill') {
          const r = killSession(sid);
          return { success: r.ok, output: r.reason ?? `已终止 ${sid}` };
        }
        if (action === 'wait') {
          const t = Number(args.timeoutMs) || 30000;
          const r = await waitSession(sid, t);
          return { success: r.ok, output: r.session ? `${r.session.status} exit=${r.session.exitCode}${r.session.timedOut ? ' (超时)' : ''}\n${r.session.output || '(无输出)'}` : '未知 session' };
        }
        // poll
        const r = pollSession(sid);
        if (!r.ok || !r.session) return { success: false, error: `未知 session ${sid}` };
        const s = r.session;
        return { success: true, output: `[${s.status}] exit=${s.exitCode}${s.status === 'running' ? ' (运行中)' : ''}\n${s.output || '(无输出)'}` };
      } catch (e: any) {
        return { success: false, error: `process ${action} 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
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
        // 2026-08-12 (TaskC): 写前暂存 (准备阶段) — 记录变更前快照, 支持审计/撤销. 失败静默.
        let before = '';
        try { before = await fs.readFile(absPath, 'utf-8'); } catch { /* 新文件 */ }
        const action = before.length > 0 ? 'overwrite' : 'create';
        const { stageWrite } = await import('./write-staging.js');
        await stageWrite(relPath, before, content, action, ctx.cwd).catch(() => {});
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
        // 2026-08-12 (TaskC): 写前暂存 (准备阶段) — 记录变更前快照, 支持审计/撤销. 失败静默.
        const { stageWrite } = await import('./write-staging.js');
        await stageWrite(relPath, original, updated, 'edit', ctx.cwd).catch(() => {});
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

  // ============================================================
  // Web 上网工具 (2026-08-04) — fetch_url + web_search
  // 用 undici request (独立连接池, 与 pi-ai 一致, 避开全局 fetch 僵尸连接问题)
  // ============================================================
  ctx.tools.set('fetch_url', {
    name: 'fetch_url',
    description: '抓取一个 URL 的网页内容并转成纯文本. 适合查文档/新闻/API 页面. 返回前 4000 字符. HTML 自动去标签, JSON/文本原样返回. (走 curl, 兼容 TLS 指纹风控)',
    parameters: { url: '完整 URL (必填, 含 https://)' },
    execute: async (args) => {
      try {
        const url = String(args.url || '').trim();
        if (!url) return { success: false, error: 'url 必填' };
        if (!/^https?:\/\//i.test(url)) return { success: false, error: 'url 必须以 http(s):// 开头' };
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const pExecFile = promisify(execFile);
        const { stdout, stderr } = await pExecFile('curl', [
          '-sL', '--max-time', '25',
          '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
          url,
        ], { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
        if (!stdout && stderr) return { success: false, error: `fetch_url 失败: ${String(stderr).slice(0, 200)}` };
        const raw = stdout.slice(0, 60_000);
        const trimmed = raw.trimStart();
        let text: string;
        if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || /^<\?xml/i.test(trimmed)) {
          text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        } else {
          text = raw;
        }
        const out = text.slice(0, 4000);
        return { success: true, output: `🌐 ${url} (${raw.length} bytes):\n${out}${text.length > 4000 ? '\n...(截断, 共 ' + text.length + ' 字符)' : ''}` };
      } catch (e: any) {
        return { success: false, error: `fetch_url 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('web_search', {
    name: 'web_search',
    description: '网页搜索. 无 key 时走 DuckDuckGo Instant Answer API + Wikipedia (知识/资讯查询可靠); 配置 TAVILY_API_KEY 时走 Tavily 完整搜索 (更全). 返回前 8 条标题+URL+摘要.',
    parameters: { query: '搜索词 (必填)' },
    execute: async (args) => {
      try {
        const query = String(args.query || '').trim();
        if (!query) return { success: false, error: 'query 必填' };
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const pExecFile = promisify(execFile);
        const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
        const curlJson = async (url: string): Promise<any> => {
          const r = await pExecFile('curl', ['-s', '--max-time', '15', '-A', UA, url], { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
          return JSON.parse(r.stdout);
        };

        // 引擎 0: Tavily (配了 TAVILY_API_KEY 时最完整)
        const tavilyKey = process.env.TAVILY_API_KEY || '';
        if (tavilyKey) {
          const r = await pExecFile('curl', [
            '-s', '--max-time', '20', '-A', UA,
            '-X', 'POST', 'https://api.tavily.com/search',
            '-H', 'Content-Type: application/json',
            '-d', JSON.stringify({ api_key: tavilyKey, query, max_results: 8, include_answer: true }),
          ], { maxBuffer: 4 * 1024 * 1024, timeout: 25_000 });
          const d = JSON.parse(r.stdout);
          const results: any[] = d.results || [];
          if (results.length > 0) {
            const lines = results.slice(0, 8).map((x, i) => `${i + 1}. ${x.title}\n  ${x.url}${x.content ? '\n   ' + String(x.content).replace(/\s+/g, ' ').slice(0, 150) : ''}`);
            const answer = d.answer ? `\n📌 ${d.answer}\n` : '';
            return { success: true, output: `🔎 "${query}" 结果 ${results.length} 条 (Tavily):${answer}\n\n${lines.join('\n\n')}` };
          }
        }

        // 引擎 1: DuckDuckGo Instant Answer API (摘要 + 相关主题)
        try {
          const ia = await curlJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
          const out: string[] = [];
          if (ia.AbstractText && ia.AbstractURL) {
            out.push(`📖 ${ia.AbstractText.slice(0, 400)}\n  ${ia.AbstractURL}`);
          }
          const topics: any[] = Array.isArray(ia.RelatedTopics) ? ia.RelatedTopics : [];
          for (const t of topics) {
            if (out.length >= 8) break;
            if (t.Topics) { // 分类组
              for (const sub of t.Topics) {
                if (out.length >= 8) break;
                if (sub.Text && sub.FirstURL) out.push(`${out.length + 1}. ${sub.Text.slice(0, 200)}\n  ${sub.FirstURL}`);
              }
            } else if (t.Text && t.FirstURL) {
              out.push(`${out.length + 1}. ${t.Text.slice(0, 200)}\n  ${t.FirstURL}`);
            }
          }
          if (out.length > 0) {
            return { success: true, output: `🔎 "${query}" (DuckDuckGo):\n\n${out.join('\n\n')}` };
          }
        } catch { /* fallback */ }

        // 引擎 2: Wikipedia 搜索 API
        try {
          const wiki = await curlJson(`https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`);
          const hits: any[] = wiki?.query?.search || [];
          if (hits.length > 0) {
            const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n  https://zh.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}\n   ${String(h.snippet || '').replace(/<[^>]+>/g, '').slice(0, 120)}`);
            return { success: true, output: `🔎 "${query}" (维基百科 ${hits.length} 条):\n\n${lines.join('\n\n')}` };
          }
        } catch { /* fallback */ }

        return { success: true, output: `🔎 "${query}" 无结果 (免费引擎无匹配, 可配 TAVILY_API_KEY 提升覆盖)` };
      } catch (e: any) {
        return { success: false, error: `web_search 失败: ${String(e?.message || e).slice(0, 200)}` };
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

  // ============================================================
  // skill 写工具 (2026-08-02) — 让 agent 从成功经验沉淀技能
  // create_skill / update_skill / list_skill_candidates / promote_skill
  // 实现: skill-writer.ts (写 ~/.bolloon/skills/<name>/SKILL.md)
  // ============================================================
  ctx.tools.set('create_skill', {
    name: 'create_skill',
    description: '创建/覆盖一个 skill (SKILL.md). 当你学会一个可复用的做事方法 (成功流程/命令组合/踩坑教训) 时调用, 沉淀成技能供以后复用. 写 ~/.bolloon/skills/<name>/SKILL.md. 只读技能请用 update_skill 追加.',
    parameters: {
      name: 'skill 名 (必填, 小写字母数字连字符, e.g. "p2p-debug")',
      description: '一句话描述这个 skill 什么时候用 (必填)',
      body: 'Markdown 正文 (必填): 步骤 / 命令 / 注意事项',
      scope: '可选: user (默认, ~/.bolloon/skills) 或 project (.bolloon/skills)',
      triggers: '可选: 触发条件数组 (JSON 字符串数组, e.g. ["p2p", "连接失败"])',
    },
    execute: async (args) => {
      try {
        const { createSkill } = await import('./skill-writer.js');
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'name 必填' };
        const body = String(args.body || '').trim();
        if (!body) return { success: false, error: 'body 必填' };
        let triggers: string[] | undefined;
        try {
          const t = JSON.parse(String(args.triggers || '[]'));
          if (Array.isArray(t)) triggers = t.map(String);
        } catch { /* triggers 解析失败忽略 */ }
        const r = await createSkill(name, String(args.description || ''), body, {
          scope: args.scope === 'project' ? 'project' : 'user',
          triggers,
        });
        return r.ok
          ? { success: true, output: `✅ skill '${name}' 已写入 ${r.path}` }
          : { success: false, error: r.error };
      } catch (e) {
        return { success: false, error: `create_skill 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('update_skill', {
    name: 'update_skill',
    description: '更新已有 skill: 追加新经验 (append_body) 或整体替换 (body), 或改描述/触发条件. skill 不存在时用 create_skill.',
    parameters: {
      name: 'skill 名 (必填)',
      append_body: '追加到正文尾部的增量经验 (可选)',
      body: '整体替换正文 (可选, 与 append_body 二选一)',
      description: '新描述 (可选)',
      triggers: '新触发条件数组 JSON (可选)',
    },
    execute: async (args) => {
      try {
        const { updateSkill } = await import('./skill-writer.js');
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'name 必填' };
        let triggers: string[] | undefined;
        try {
          const t = JSON.parse(String(args.triggers || '[]'));
          if (Array.isArray(t)) triggers = t.map(String);
        } catch { /* 忽略 */ }
        const r = await updateSkill(name, {
          description: args.description ? String(args.description) : undefined,
          appendBody: args.append_body ? String(args.append_body) : undefined,
          body: args.body ? String(args.body) : undefined,
          triggers,
        });
        return r.ok
          ? { success: true, output: `✅ skill '${name}' 已更新 ${r.path}` }
          : { success: false, error: r.error };
      } catch (e) {
        return { success: false, error: `update_skill 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('list_skill_candidates', {
    name: 'list_skill_candidates',
    description: '查看待沉淀的 skill 候选 (后台任务从成功的工具调用模式生成的候选). 返回候选列表, 可用 promote_skill 转正.',
    parameters: {},
    execute: async () => {
      try {
        const { listSkillCandidates } = await import('./skill-writer.js');
        const cands = await listSkillCandidates();
        if (cands.length === 0) return { success: true, output: '暂无待沉淀的 skill 候选.' };
        const lines = cands.map(c => `- ${c.name}: ${c.description} [来源 ${c.source}]`).join('\n');
        return { success: true, output: `📋 ${cands.length} 个 skill 候选:\n${lines}` };
      } catch (e) {
        return { success: false, error: `list_skill_candidates 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('promote_skill', {
    name: 'promote_skill',
    description: '把 skill 候选转正为正式 skill. 转正后候选文件自动清理.',
    parameters: { name: '候选名 (必填, 见 list_skill_candidates)' },
    execute: async (args) => {
      try {
        const { promoteCandidate } = await import('./skill-writer.js');
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'name 必填' };
        const r = await promoteCandidate(name);
        return r.ok
          ? { success: true, output: `✅ 候选 '${name}' 已转正 → ${r.path}` }
          : { success: false, error: r.error };
      } catch (e) {
        return { success: false, error: `promote_skill 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // plan / todo / review 工具 (2026-08-02) — 显式执行闭环
  // create_plan / update_plan / review_plan / list_plans
  // 实现: plan-store.ts (~/.bolloon/plans/<planId>.json)
  // ============================================================
  ctx.tools.set('create_plan', {
    name: 'create_plan',
    description: '执行复杂任务前先显式列计划: 拆成 3-8 个可执行步骤. 之后每完成一步调 update_plan 勾选, 全部完成调 review_plan 总结. 落盘 ~/.bolloon/plans/.',
    parameters: {
      goal: '一句话目标 (必填)',
      steps: '步骤数组 JSON (必填, e.g. ["读需求", "写代码", "测试"])',
    },
    execute: async (args) => {
      try {
        const { createPlan, planToContext } = await import('./plan-store.js');
        const goal = String(args.goal || '').trim();
        let steps: string[] = [];
        try {
          const s = JSON.parse(String(args.steps || '[]'));
          if (Array.isArray(s)) steps = s.map(String);
        } catch { /* steps 解析失败 */ }
        const r = await createPlan({ goal, steps, createdBy: 'agent', originChannel: (ctx as any).channelId || '' });
        if (!r.ok || !r.plan) return { success: false, error: r.error };
        return { success: true, output: `✅ 计划已创建 ${r.plan.planId}\n\n${planToContext(r.plan)}` };
      } catch (e) {
        return { success: false, error: `create_plan 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('update_plan', {
    name: 'update_plan',
    description: '更新计划: 勾选某步完成/阻塞 (step_id + status), 或追加新步骤 (append_steps), 或整体结束 (finish=true). 执行中每完成一步必调.',
    parameters: {
      plan_id: '计划 ID (必填, create_plan 返回)',
      step_id: '步骤 ID (可选, e.g. step_1)',
      status: '步骤新状态: done / blocked (可选)',
      note: '完成/阻塞备注 (可选)',
      append_steps: '追加步骤数组 JSON (可选)',
      finish: 'true 表示整个计划结束 (可选)',
    },
    execute: async (args) => {
      try {
        const { updatePlan, planToContext } = await import('./plan-store.js');
        const planId = String(args.plan_id || '').trim();
        if (!planId) return { success: false, error: 'plan_id 必填' };
        let appendSteps: string[] | undefined;
        try {
          const s = JSON.parse(String(args.append_steps || '[]'));
          if (Array.isArray(s)) appendSteps = s.map(String);
        } catch { /* 忽略 */ }
        const r = await updatePlan(planId, {
          stepId: args.step_id ? String(args.step_id) : undefined,
          status: (args.status === 'done' || args.status === 'blocked') ? args.status : undefined,
          note: args.note ? String(args.note) : undefined,
          appendSteps,
          finish: String(args.finish) === 'true',
        });
        if (!r.ok || !r.plan) return { success: false, error: r.error };
        return { success: true, output: `✅ 计划已更新\n\n${planToContext(r.plan)}` };
      } catch (e) {
        return { success: false, error: `update_plan 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('review_plan', {
    name: 'review_plan',
    description: '计划全部执行完后审查: 总结完成度 + 产出结论. 完成后 plan 标记 done.',
    parameters: {
      plan_id: '计划 ID (必填)',
      summary: '审查总结 (必填, 说明完成了什么/卡在哪/下一步)',
    },
    execute: async (args) => {
      try {
        const { reviewPlan } = await import('./plan-store.js');
        const planId = String(args.plan_id || '').trim();
        if (!planId) return { success: false, error: 'plan_id 必填' };
        const summary = String(args.summary || '').trim();
        if (!summary) return { success: false, error: 'summary 必填' };
        const r = await reviewPlan(planId, summary);
        if (!r.ok || !r.plan) return { success: false, error: r.error };
        return {
          success: true,
          output: `✅ 计划审查完成: ${r.plan.review!.completedSteps}/${r.plan.review!.totalSteps} 步\n📝 ${summary}`,
        };
      } catch (e) {
        return { success: false, error: `review_plan 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('list_plans', {
    name: 'list_plans',
    description: '列出所有进行中的计划 (active). 用于恢复上下文/继续未完成的计划.',
    parameters: {},
    execute: async () => {
      try {
        const { listActivePlans, planToContext } = await import('./plan-store.js');
        const plans = await listActivePlans();
        if (plans.length === 0) return { success: true, output: '暂无进行中的计划.' };
        const text = plans.map(p => planToContext(p)).join('\n\n');
        return { success: true, output: `📋 ${plans.length} 个进行中的计划:\n\n${text}` };
      } catch (e) {
        return { success: false, error: `list_plans 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // 决策协议工具 (2026-08-03, Context OS §7) — 可回滚的推理链
  // create_decision / decide_decision / rollback_decision / list_decisions
  // 实现: decision-store.ts (~/.bolloon/decisions/<id>.json)
  // 9 要素: 问题/选项(含不做)/成本/收益/风险/信息缺口/推荐/时机/回滚
  // 决策确认 (decide_decision) 自动 reflect 到 judgeness (HumanJudgment + JudgenessDescription)
  // ============================================================
  ctx.tools.set('create_decision', {
    name: 'create_decision',
    description: '重大决策前先写推理链 (Context OS 9 要素): problem 问题是什么, options 选项数组 (含"不做"), info_gaps 信息缺口, recommendation 推荐方案, timing 为什么是现在, rollback 失败时回滚条件. 之后用 decide_decision 确认.',
    parameters: {
      problem: '问题到底是什么 (必填)',
      options: '选项数组 JSON (必填, e.g. [{"label":"方案A","costs":"成本","benefits":"收益","risks":"风险"},{"label":"什么都不做","includeDoNothing":true}])',
      info_gaps: '当前信息缺口 (可选)',
      recommendation: '推荐方案 (可选, 确认时必填)',
      timing: '为什么是现在 (可选)',
      rollback: '失败时的回滚条件 (可选)',
      stakes: '风险等级: low / medium / high / critical (可选)',
      domain: '领域 (可选)',
    },
    execute: async (args) => {
      try {
        const { createDecision, decisionToContext } = await import('./decision-store.js');
        const problem = String(args.problem || '').trim();
        if (!problem) return { success: false, error: 'problem 必填' };
        let options: any[] = [];
        try {
          const s = JSON.parse(String(args.options || '[]'));
          if (Array.isArray(s)) options = s;
        } catch { /* options 解析失败 */ }
        const rawStakes = String(args.stakes || 'medium');
        const stakes: 'low' | 'medium' | 'high' | 'critical' =
          rawStakes === 'low' || rawStakes === 'high' || rawStakes === 'critical' ? rawStakes : 'medium';
        const r = await createDecision({
          problem,
          options,
          infoGaps: args.info_gaps ? String(args.info_gaps) : undefined,
          recommendation: args.recommendation ? String(args.recommendation) : undefined,
          timing: args.timing ? String(args.timing) : undefined,
          rollback: args.rollback ? String(args.rollback) : undefined,
          stakes,
          domain: args.domain ? String(args.domain) : undefined,
          by: 'agent',
          originChannel: (ctx as any).channelId || '',
        });
        if (!r.ok || !r.decision) return { success: false, error: r.error };
        return { success: true, output: `✅ 决策推理链已创建 ${r.decision.decisionId}\n\n${decisionToContext(r.decision)}` };
      } catch (e) {
        return { success: false, error: `create_decision 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('decide_decision', {
    name: 'decide_decision',
    description: '确认一个决策 (必须已有 recommendation). 确认后自动把该决策入库 judgeness (HumanJudgment + 5 维描述, 阶段0 临时价值点). 决策确认后状态 → decided.',
    parameters: {
      decision_id: '决策 ID (必填, create_decision 返回)',
      recommendation: '最终推荐方案 (必填, 若创建时未填)',
    },
    execute: async (args) => {
      try {
        const { updateDecisionStatus } = await import('./decision-store.js');
        const decisionId = String(args.decision_id || '').trim();
        if (!decisionId) return { success: false, error: 'decision_id 必填' };
        const r = await updateDecisionStatus(
          decisionId,
          { decide: true, recommendation: args.recommendation ? String(args.recommendation) : undefined },
          { byAgentId: (ctx as any).agentId || '' }
        );
        if (!r.ok || !r.decision) return { success: false, error: r.error };
        const refl = r.decision.reflection ? ` (已入库 judgeness: hv=${r.decision.reflection.hvId})` : '';
        return { success: true, output: `✅ 决策已确认: ${r.decision.problem} → ${r.decision.recommendation}${refl}` };
      } catch (e) {
        return { success: false, error: `decide_decision 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('rollback_decision', {
    name: 'rollback_decision',
    description: '决策失败触发回滚条件时调用: 标记 rolled-back + 记录教训 (reject 语义入库 judgeness, 防止重复踩坑).',
    parameters: {
      decision_id: '决策 ID (必填)',
      reason: '失败/回滚原因 (必填, 将作为教训入库)',
    },
    execute: async (args) => {
      try {
        const { updateDecisionStatus } = await import('./decision-store.js');
        const decisionId = String(args.decision_id || '').trim();
        if (!decisionId) return { success: false, error: 'decision_id 必填' };
        const reason = String(args.reason || '').trim();
        if (!reason) return { success: false, error: 'reason 必填 (回滚原因)' };
        const r = await updateDecisionStatus(decisionId, { rollback: true, reason }, { byAgentId: (ctx as any).agentId || '' });
        if (!r.ok || !r.decision) return { success: false, error: r.error };
        return { success: true, output: `↩️ 决策已回滚: ${r.decision.problem}\n教训已入库 judgeness (reject 语义): ${reason.slice(0, 120)}` };
      } catch (e) {
        return { success: false, error: `rollback_decision 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('list_decisions', {
    name: 'list_decisions',
    description: '列出全部决策 (按创建时间倒序). 可选 status 过滤: draft / decided / implemented / abandoned / rolled-back. 用于恢复决策上下文.',
    parameters: {
      status: '可选过滤: draft / decided / implemented / abandoned / rolled-back',
    },
    execute: async (args) => {
      try {
        const { listDecisions, decisionToContext } = await import('./decision-store.js');
        const status = ['draft', 'decided', 'implemented', 'abandoned', 'rolled-back'].includes(args.status) ? args.status : undefined;
        const decisions = await listDecisions(status as any);
        if (decisions.length === 0) return { success: true, output: '暂无决策记录.' };
        const text = decisions.slice(0, 8).map(d => decisionToContext(d)).join('\n\n');
        return { success: true, output: `🧭 ${decisions.length} 条决策 (9 要素推理链可追溯):\n\n${text}` };
      } catch (e) {
        return { success: false, error: `list_decisions 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // Context OS 资产层工具 (2026-08-03, P5) — 12+3 层文件夹体系
  // list_context_layers / write_context_asset / read_context_assets
  // 实现: src/bootstrap/context-os.ts (~/.bolloon/context-os/)
  // 价值判断: 写入前回答"未来哪个具体场景会用到它?" — 回答不出进 tmp/
  // ============================================================
  ctx.tools.set('list_context_layers', {
    name: 'list_context_layers',
    description: '列出 Context OS 资产层 (12+3 层: 01-Me 我是谁 / 02-Network 我认识谁 / 03-Current 我在做什么 / 04-Projects 项目 / 05-Prompts 提示词 / 06-Protocols 协议 / 07-Knowledge 知识 / 08-Insights 洞察 / 09-Tools 工具 / 10-Skills 技能 / 11-Write 写作 / 12-Analysis 决策复盘 / output / research / tmp) + 每层资产数. 任务前先看目录, 再按任务路由读取对应层.',
    parameters: {},
    execute: async () => {
      try {
        const { readContextAssets, formatLayerListing } = await import('../bootstrap/context-os.js');
        // 2026-08-09: 按 agentId 分区读取 (每个智能体独立 Context OS)
        const listings = await readContextAssets(undefined, undefined, undefined, (ctx as any).agentId || '');
        const total = listings.reduce((s, l) => s + l.fileCount, 0);
        if (total === 0) return { success: true, output: '📂 Context OS 资产层已就绪 (12+3 层), 当前暂无资产. 有价值的内容用 write_context_asset 写入对应层.' };
        return { success: true, output: `📂 Context OS 资产层共 ${total} 篇资产:\n\n${formatLayerListing(listings)}` };
      } catch (e) {
        return { success: false, error: `list_context_layers 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('write_context_asset', {
    name: 'write_context_asset',
    description: '把已验证的价值写入 Context OS 资产层 (唯一落点, 不制造重复文件). 写入前先自检: 未来哪个具体场景会用到它? 回答不出 → 写 tmp/ 或放弃. layer 可选: 01-Me 原则边界 / 02-Network 人脉 / 03-Current 当前状态 / 04-Projects 项目 / 05-Prompts 已验证提示词 / 06-Protocols 规则 / 07-Knowledge 跨项目知识 / 08-Insights 已验证洞察/教训 / 09-Tools 工具经验 / 10-Skills 可验证能力 / 11-Write 成熟表达 / 12-Analysis 决策复盘 / output 对外交付 / research 中间成果 / tmp 一次性草稿.',
    parameters: {
      layer: '层 key (必填, 见 description 列表)',
      title: '资产标题 (必填, 一句话)',
      content: '资产正文 markdown (必填)',
      tags: '可选 tags 数组 JSON',
      domain: '可选领域',
    },
    execute: async (args) => {
      try {
        const { writeContextAsset } = await import('../bootstrap/context-os.js');
        const layer = String(args.layer || '').trim();
        const title = String(args.title || '').trim();
        const content = String(args.content || '').trim();
        if (!layer) return { success: false, error: 'layer 必填 (如 07-Knowledge)' };
        if (!title) return { success: false, error: 'title 必填' };
        if (!content) return { success: false, error: 'content 必填' };
        let tags: string[] = [];
        try {
          const t = JSON.parse(String(args.tags || '[]'));
          if (Array.isArray(t)) tags = t.map(String);
        } catch { /* tags 解析失败 */ }
        const r = await writeContextAsset({ layer, title, content, tags, domain: args.domain ? String(args.domain) : undefined }, undefined, (ctx as any).agentId || '');
        if (!r.ok) return { success: false, error: r.error };
        if (r.skipped) return { success: true, output: `⏭️ ${r.error}` };
        return { success: true, output: `📥 已写入资产层 ${r.asset!.layer}: ${r.asset!.title} (stage0 临时价值点, 待验证后固化)\n路径: ${r.asset!.path}` };
      } catch (e) {
        return { success: false, error: `write_context_asset 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('read_context_assets', {
    name: 'read_context_assets',
    description: '读取 Context OS 资产层内容. layer 可选 (空 = 全层汇总); keyword 可选 (标题/内容过滤). 做项目前先读 04-Projects 对应项目, 重大决策前读 08-Insights + 12-Analysis, 学技术读 07-Knowledge + 09-Tools.',
    parameters: {
      layer: '可选层 key (如 07-Knowledge), 空 = 全部',
      keyword: '可选关键词过滤',
    },
    execute: async (args) => {
      try {
        const { readContextAssets, formatLayerListing } = await import('../bootstrap/context-os.js');
        const layer = args.layer ? String(args.layer) : undefined;
        const kw = args.keyword ? String(args.keyword) : undefined;
        // 2026-08-09: 按 agentId 分区读取 (每个智能体独立 Context OS)
        const listings = await readContextAssets(layer, kw, undefined, (ctx as any).agentId || '');
        if (listings.every((l) => l.fileCount === 0)) {
          return { success: true, output: layer ? `📂 资产层 ${layer} 暂无资产` : '📂 资产层暂无资产' };
        }
        // 单层且有 keyword → 输出完整正文
        if (layer && kw) {
          const found = listings[0]?.files || [];
          const { readAssetBody } = await import('../bootstrap/context-os.js');
          const bodies: string[] = [];
          for (const f of found.slice(0, 5)) {
            try {
              const r = await readAssetBody(layer, f.file);
              if (r.ok && r.body) bodies.push(`--- ${f.title} ---\n${r.body.slice(0, 2000)}\n--- 结束 ---`);
            } catch { /* 跳过 */ }
          }
          return { success: true, output: bodies.length > 0 ? bodies.join('\n\n') : '未找到匹配资产' };
        }
        return { success: true, output: formatLayerListing(listings) };
      } catch (e) {
        return { success: false, error: `read_context_assets 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // MCP 工具 (2026-08-03) — 外部 MCP server 接入 agent 工具系统
  // 配置: ~/.mcp.json (mcpServers), 启动时 initializeMcpAdapter 自动握手发现工具
  // mcp_list_tools: 列出已发现的 MCP 工具
  // mcp_tool: 调用任意 MCP 工具 (真实 stdio JSON-RPC)
  // ============================================================
  ctx.tools.set('mcp_list_tools', {
    name: 'mcp_list_tools',
    description: '列出通过 MCP 协议连接的可用外部工具 (来自 ~/.mcp.json 配置的 MCP servers). 调用 MCP 工具前先列一次, 拿准确工具名和参数.',
    parameters: {},
    execute: async () => {
      try {
        const mcp = await import('../pi-ecosystem-mcp/index.js');
        await mcp.initializeMcpAdapter().catch(() => {});
        const tools = mcp.listTools();
        if (tools.length === 0) {
          return { success: true, output: '未发现 MCP 工具. 配置 ~/.mcp.json (mcpServers: {name: {command, args}}), 重启后自动连接.' };
        }
        const lines = tools.map((t) => `  - ${t.name} (${t.serverName}): ${t.description?.slice(0, 80) || '无描述'}`);
        return { success: true, output: `🔌 ${tools.length} 个 MCP 工具可用:\n${lines.join('\n')}\n\n调用用 mcp_tool (tool=工具名, arguments=参数 JSON)` };
      } catch (e) {
        return { success: false, error: `mcp_list_tools 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // verify_project (2026-08-11, Hermes agent/verify recipes 模式)
  // 从项目 package.json scripts 提取验证命令依序执行 (build→typecheck→test→check→lint)
  // 完成契约 (B7) 的证据工具: 宣布完成前跑一遍, 输出命令/exit code/耗时
  // ============================================================
  ctx.tools.set('verify_project', {
    name: 'verify_project',
    description: '运行项目验证配方 (Hermes verify recipes 模式): 从 package.json scripts 自动提取 build/typecheck/test/check/lint 依序执行, 返回每步命令+exit code+耗时+输出尾部. 修改代码后、宣布完成前调用 — 提供完成契约要求的证据. cwd 选项目根 (默认当前工作目录).',
    parameters: {
      cwd: '项目根目录 (可选, 默认当前 cwd)',
    },
    execute: async (args) => {
      try {
        const { readFileSync, readdirSync } = await import('fs');
        const { extractVerifyCommands, detectPackageManager, runVerifyCommands } = await import('./verify-recipe.js');
        const cwd = String(args.cwd || process.cwd()).trim() || process.cwd();
        let pkg: Record<string, unknown> = {};
        try {
          pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf-8'));
        } catch {
          return { success: false, error: `${cwd}/package.json 不存在或非法 — verify_project 只支持 npm/pnpm/yarn/bun 项目` };
        }
        const scripts = (pkg.scripts ?? {}) as Record<string, string>;
        const pm = detectPackageManager(readdirSync(cwd).map((f) => f.toLowerCase()));
        const commands = extractVerifyCommands(scripts, pm);
        if (commands.length === 0) {
          return { success: false, error: 'package.json scripts 里没有 build/typecheck/test/check/lint 任何一步 — 无可验证' };
        }
        const r = await runVerifyCommands({ cwd, commands });
        const lines = r.steps.map((s) =>
          `  ${s.exitCode === 0 ? '✅' : '❌'} ${s.name} (${s.command}) → exit ${s.exitCode ?? 'ERR'} ${s.durationMs}ms${s.timedOut ? ' [超时]' : ''}`
        );
        const failedStep = r.steps.find((s) => s.exitCode !== 0 || s.timedOut);
        return {
          success: r.allPassed,
          output: `${r.allPassed ? '✅ 验证全部通过' : '❌ 验证失败'} (${r.steps.filter((s) => s.exitCode === 0).length}/${r.steps.length} 步):\n${lines.join('\n')}${failedStep ? `\n\n失败输出尾部:\n${failedStep.outputTail.slice(-1500)}` : ''}`,
          ...(r.allPassed ? {} : { error: `验证失败于 ${failedStep?.name} (exit ${failedStep?.exitCode})` }),
        };
      } catch (e) {
        return { success: false, error: `verify_project 失败: ${String(e).slice(0, 200)}` };
      }
    },
  });

  ctx.tools.set('mcp_list_catalog', {
    name: 'mcp_list_catalog',
    description: '列出 Bolloon 审核过的可选 MCP 目录 (Hermes optional-mcps 模式: 默认禁用, 显式安装才生效). 想看"有哪些外部工具可以接"时用这个; 已接入的看 mcp_list_tools.',
    parameters: {},
    execute: async () => {
      try {
        // fs 读 manifests/mcp-catalog.json — 构建后 dist/agents/../../manifests = 仓库根/manifests
        const { readFileSync } = await import('fs');
        const raw = readFileSync(new URL('../../manifests/mcp-catalog.json', import.meta.url), 'utf-8');
        const catalog = JSON.parse(raw);
        const entries = (catalog?.entries ?? []) as Array<{
          name: string;
          description: string;
          transport?: { type: string; url?: string; command?: string };
        }>;
        if (entries.length === 0) {
          return { success: true, output: '📦 MCP 目录为空. 新增条目: manifests/mcp-catalog.json (实测可用才收录).' };
        }
        const lines = entries.map((e) => {
          const t = e.transport?.type ?? 'unknown';
          const addr = e.transport?.url ?? e.transport?.command ?? '';
          return `  - ${e.name} [${t}] ${addr ? '(' + addr + ')' : ''}: ${e.description?.slice(0, 70) || ''}`;
        });
        return {
          success: true,
          output: `📦 可选 MCP 目录 (${entries.length} 条, 默认禁用):\n${lines.join('\n')}\n\n安装: 把条目按 mcpServers 格式写进 ~/.mcp.json, 重启后 mcp_list_tools 可见. 版本必须精确 pin (Hermes 纪律).`,
        };
      } catch (e) {
        return { success: false, error: `mcp_list_catalog 失败: ${String(e).slice(0, 200)}` };
      }
    },
  });

  ctx.tools.set('mcp_tool', {
    name: 'mcp_tool',
    description: '调用外部 MCP 工具 (真实 stdio JSON-RPC 通信). tool = 工具名 (先用 mcp_list_tools 查看), arguments = 参数 JSON 对象.',
    parameters: {
      tool: 'MCP 工具名 (必填)',
      arguments: '参数 JSON 对象 (必填, e.g. {"text":"hello"})',
    },
    execute: async (args) => {
      try {
        const mcp = await import('../pi-ecosystem-mcp/index.js');
        const tool = String(args.tool || '').trim();
        if (!tool) return { success: false, error: 'tool 必填' };
        let argumentsObj: Record<string, unknown> = {};
        try {
          const a = JSON.parse(String(args.arguments || '{}'));
          if (a && typeof a === 'object') argumentsObj = a;
        } catch {
          return { success: false, error: 'arguments 必须是 JSON 对象' };
        }
        const r = await mcp.executeTool(tool, argumentsObj);
        if (!r.success) return { success: false, error: r.error || 'MCP 调用失败' };
        const text = Array.isArray(r.content)
          ? r.content.map((c: any) => c?.text ?? '').filter(Boolean).join('\n')
          : JSON.stringify(r.content);
        return { success: true, output: `🔧 MCP ${tool}:\n${text.slice(0, 4000)}` };
      } catch (e) {
        return { success: false, error: `mcp_tool 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // 2026-08-12: MCP 驱动前端 UI 工具 — agent 理解用户意图后调用, 通过 SSE 广播驱动前端组件.
  //   复用 ui-tools (dispatchUiAction → broadcast {type:'ui'}), 前端订阅 /events 执行.
  const registerUiAgentTools = async () => {
    const ui = await import('../pi-ecosystem-mcp/ui-tools.js');
    // 注册到 MCP 系统 (供 mcp_list_tools 可见) + 注册为 agent 工具
    ui.registerUiControlTools();
    const uiTools: Array<{ name: string; description: string; params: Record<string, string>; map: (args: any) => any }> = [
      { name: 'ui_switch_tab', description: '驱动前端切换底部 tab (微信/通讯录/发现/我). 用户想"去通讯录/去设置/去我的"时调用.', params: { tab: 'wechat|contacts|discover|me (必填)' }, map: (a) => ({ action: 'switchTab', data: { tab: String(a.tab || '') } }) },
      { name: 'ui_open_chat', description: '驱动前端打开某个智能体聊天页. 用户想"打开和 X 的聊天"时调用.', params: { channelId: '目标 channel id (必填)' }, map: (a) => ({ action: 'openChat', data: { channelId: String(a.channelId || '') } }) },
      { name: 'ui_open_settings', description: '驱动前端打开设置页.', params: {}, map: () => ({ action: 'openSettings', data: {} }) },
      { name: 'ui_open_wallet', description: '驱动前端打开钱包.', params: {}, map: () => ({ action: 'openWallet', data: {} }) },
      { name: 'ui_open_add_friend', description: '驱动前端打开添加好友.', params: {}, map: () => ({ action: 'openAddFriend', data: {} }) },
      { name: 'ui_show_toast', description: '驱动前端顶部显示提示 (toast).', params: { message: '提示内容 (必填)' }, map: (a) => ({ action: 'showToast', data: { message: String(a.message || '') } }) },
      { name: 'ui_go_back', description: '驱动前端返回上一页.', params: {}, map: () => ({ action: 'goBack', data: {} }) },
    ];
    for (const t of uiTools) {
      ctx.tools.set(t.name, {
        name: t.name,
        description: t.description,
        parameters: t.params,
        execute: async (args) => {
          const r = ui.dispatchUiAction(t.map(args));
          return r.success ? { success: true, output: r.output } : { success: false, error: r.output };
        },
      });
    }
  };
  registerUiAgentTools().catch(() => {});

  // 2026-08-12: A2UI (Agent to UI) 工具 — agent 生成 A2UI 消息 (createSurface/updateComponents),
  //   经 SSE 广播, 前端用 @a2ui/react renderer 渲染. 见 src/pi-ecosystem-a2ui/.
  (async () => {
    try {
      const a2ui = await import('../pi-ecosystem-a2ui/index.js');
      for (const t of a2ui.A2UI_TOOL_DEFS) {
        ctx.tools.set(t.name, {
          name: t.name,
          description: t.description,
          parameters: t.params,
          execute: async (args) => {
            const r = a2ui.dispatchA2uiMessage(t.build(args));
            return r.success ? { success: true, output: r.output } : { success: false, error: r.output };
          },
        });
      }
    } catch { /* A2UI 工具注册失败静默 */ }
  })();

  // 2026-08-13 (Phase E1): Agent 服务 Registry — 注册/发现服务 (Agent Economic Network Discovery 层)
  (async () => {
    try {
      const registry = await import('../agents/agent-registry.js');
      // 注册自己为服务提供者
      ctx.tools.set('registry_register', {
        name: 'registry_register',
        description: '在 Agent 服务注册表注册自己的服务 (定价/能力/钱包). 让其他 Agent 能发现并调用你. 参数: service_name(如 research), description, price_amount, price_currency(USDC), price_per(如 query), capabilities(数组), wallet(收款地址)',
        parameters: {
          service_name: '服务名 (必填, 如 research/coding/data)',
          description: '服务描述 (必填)',
          price_amount: '单价金额 (必填, 如 0.05)',
          price_currency: '计价币种 (默认 USDC)',
          price_per: '计价单位 (默认 query)',
          capabilities: '能力数组 (可选)',
          wallet: '收款钱包地址 (必填)',
        },
        execute: async (args) => {
          const serviceName = String(args.service_name || '').trim();
          const wallet = String(args.wallet || '').trim();
          if (!serviceName || !wallet) return { success: false, error: 'service_name 和 wallet 必填' };
          const reg = registry.getAgentRegistry();
          const r = await reg.register({
            agentId: ctx.identity?.did || `did:local:${ctx.identity?.name || 'agent'}`,
            name: ctx.identity?.name || 'agent',
            wallet,
            service: {
              name: serviceName,
              description: String(args.description || `${serviceName} 服务`).trim(),
              price: {
                amount: String(args.price_amount || '0'),
                currency: String(args.price_currency || 'USDC').toUpperCase(),
                per: String(args.price_per || 'query'),
              },
            },
            capabilities: Array.isArray(args.capabilities) ? args.capabilities.map(String) : [serviceName],
          });
          return r.ok
            ? { success: true, output: `✅ 已注册服务: ${serviceName} (${args.price_amount || 0} ${String(args.price_currency || 'USDC').toUpperCase()}/${args.price_per || 'query'}) wallet=${wallet.slice(0, 10)}...` }
            : { success: false, error: r.error };
        },
      });
      // 发现可用的 Agent 服务
      ctx.tools.set('registry_discover', {
        name: 'registry_discover',
        description: '在 Agent 服务注册表发现服务 (按名称/能力/描述). 找到服务后可用 x402 支付调用. query: 搜索词 (如 research/compute/data).',
        parameters: { query: '搜索词 (可选, 空=列出全部)' },
        execute: async (args) => {
          const q = String(args.query || '').trim();
          const reg = registry.getAgentRegistry();
          const services = await reg.discover(q);
          if (services.length === 0) return { success: true, output: '(注册表无匹配服务)' };
          const lines = services.slice(0, 20).map((s) =>
            `  [${s.service.name}] ${s.name} (${s.service.price.amount} ${s.service.price.currency}/${s.service.price.per}) wallet=${String(s.wallet).slice(0, 12)}... agent=${s.agentId.slice(0, 24)}...`
          );
          return { success: true, output: `发现 ${services.length} 个服务:\n${lines.join('\n')}` };
        },
      });
    } catch { /* registry 工具注册失败静默 */ }
  })();

  // 2026-08-13 (Phase E2): service_call — 调用 Agent 服务 (x402 402 自动支付闭环)
  ctx.tools.set('service_call', {
    name: 'service_call',
    description: '调用注册表里的 Agent 服务 (x402 支付闭环). 从 registry_discover 找到服务名后调用. service_name: 服务名; args: 服务参数; 有钱包私钥时自动支付 402.',
    parameters: {
      service_name: '服务名 (必填, registry_discover 查到的)',
      args: '服务参数 JSON (可选)',
      max_payment_amount: '最大支付金额 (可选)',
    },
    execute: async (args) => {
      const serviceName = String(args.service_name || '').trim();
      if (!serviceName) return { success: false, error: 'service_name 必填 (先用 registry_discover 查)' };
      try {
        const { serviceCall } = await import('./agent-service-client.js');
        // 尝试取 channel 钱包私钥 (autoPay)
        let privateKey: string | undefined;
        try {
          const wallet = await ctx.getChannelWallet?.();
          if (wallet?.encryptedPrivateKey) privateKey = wallet.encryptedPrivateKey;
        } catch { /* 无钱包 */ }
        let argsObj: Record<string, unknown> = {};
        try { argsObj = JSON.parse(String(args.args || '{}')); } catch { argsObj = {}; }
        const r = await serviceCall({
          serviceName,
          args: argsObj,
          privateKey,
          maxPaymentAmount: String(args.max_payment_amount || '').trim() || undefined,
        });
        if (!r.success) return { success: false, error: r.error, service: r.service?.service?.name };
        return { success: true, output: r.output, paid: r.paid, txHash: r.txHash };
      } catch (e: any) {
        return { success: false, error: `service_call 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // 2026-08-13 (Phase E3): Policy Engine — 预算/授权 (安全核心, 私钥不暴露给 LLM)
  ctx.tools.set('policy_config', {
    name: 'policy_config',
    description: '查看/更新支付策略 (预算/白名单). LLM 只能查看预算与授权规则, 私钥由 Policy Engine 隔离保管. 查看: 无参数; 更新: 传要改的字段 (per_transaction_limit/daily_limit/allowed_recipients/allowed_services).',
    parameters: {
      per_transaction_limit: '可选: 单笔上限 (数字)',
      daily_limit: '可选: 每日预算 (数字)',
      allowed_recipients: '可选: 允许收款方数组',
      allowed_services: '可选: 允许服务数组',
    },
    execute: async (args) => {
      try {
        const { getEconomicPolicy } = await import('./economic-policy.js');
        const policy = getEconomicPolicy();
        const patch: Record<string, unknown> = {};
        if (args.per_transaction_limit !== undefined) patch.perTransactionLimit = Number(args.per_transaction_limit);
        if (args.daily_limit !== undefined) patch.dailyLimit = Number(args.daily_limit);
        if (Array.isArray(args.allowed_recipients)) patch.allowedRecipients = args.allowed_recipients.map(String);
        if (Array.isArray(args.allowed_services)) patch.allowedServices = args.allowed_services.map(String);
        if (Object.keys(patch).length > 0) policy.updateConfig(patch as any);
        const spent = await policy.dailySpent();
        const c = policy.config();
        return {
          success: true,
          output: `支付策略:\n  单笔上限: $${c.perTransactionLimit}\n  每日预算: $${c.dailyLimit} (今日已用 $${spent})\n  允许收款方: ${c.allowedRecipients.length ? c.allowedRecipients.join(', ') : '(全部)'}\n  允许服务: ${c.allowedServices.length ? c.allowedServices.join(', ') : '(全部)'}\n  速率: ${c.rateLimitPerMinute}/min`,
        };
      } catch (e: any) {
        return { success: false, error: `policy_config 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // 2026-08-13 (Phase M4): Reputation — 服务结果记录 + 信誉查询 (Agent Economic Protocol §7)
  ctx.tools.set('reputation_update', {
    name: 'reputation_update',
    description: '记录一次服务结果, 更新服务提供者的信誉 (success/failed/disputed → score). 服务完成后调用. agent_id: 服务提供者 DID; service_name: 服务名; outcome: success|failed|disputed.',
    parameters: { agent_id: '服务提供者 agent_id (必填)', service_name: '服务名 (必填)', outcome: '结果: success|failed|disputed (必填)' },
    execute: async (args) => {
      try {
        const { recordServiceOutcome } = await import('./agent-reputation.js');
        const agentId = String(args.agent_id || '').trim();
        const serviceName = String(args.service_name || '').trim();
        const outcome = String(args.outcome || '').trim() as any;
        if (!agentId || !serviceName || !['success', 'failed', 'disputed'].includes(outcome)) {
          return { success: false, error: 'agent_id/service_name/outcome(success|failed|disputed) 必填' };
        }
        const r = await recordServiceOutcome(agentId, serviceName, outcome);
        if (!r.ok) return { success: false, error: r.error };
        return { success: true, output: `✅ 已记录 ${outcome}: tasks=${r.reputation?.tasks}, score=${r.reputation?.score}` };
      } catch (e: any) {
        return { success: false, error: `reputation_update 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  ctx.tools.set('reputation_query', {
    name: 'reputation_query',
    description: '查询 Agent 的信誉 (成功率/任务数). agent_id: 服务提供者 DID; service_name: 可选. 选择服务前先查信誉.',
    parameters: { agent_id: '服务提供者 agent_id (必填)', service_name: '服务名 (可选)' },
    execute: async (args) => {
      try {
        const { queryReputation, formatReputation } = await import('./agent-reputation.js');
        const r = await queryReputation(String(args.agent_id || '').trim(), String(args.service_name || '').trim() || undefined);
        if (!r.ok) return { success: true, output: r.error || '(无信誉记录)' };
        return { success: true, output: r.entries.map((e) => `  [${e.service}] ${formatReputation(e.reputation)}`).join('\n') };
      } catch (e: any) {
        return { success: false, error: `reputation_query 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // 2026-08-13: Treasury 桥 — 链下结算 (Policy/Registry) 驱动链上 Treasury.payAgent
  //   配置: BOLLOON_TREASURY_RPC / BOLLOON_TREASURY_ADDRESS / BOLLOON_TREASURY_KEY / BOLLOON_TREASURY_TOKEN
  const treasuryConfigFromEnv = () => {
    const rpcUrl = process.env.BOLLOON_TREASURY_RPC || '';
    const treasuryAddress = process.env.BOLLOON_TREASURY_ADDRESS || '';
    const tokenAddress = process.env.BOLLOON_TREASURY_TOKEN || '';
    const privateKey = process.env.BOLLOON_TREASURY_KEY || '';
    return { rpcUrl, treasuryAddress, tokenAddress, privateKey };
  };

  ctx.tools.set('treasury_pay', {
    name: 'treasury_pay',
    description: '从 Treasury 支付给 Agent (链上 AgentTreasury.payAgent). 自动过 Policy 预算校验 + 信誉门槛 (链上). agent_address: 收款 Agent 地址; amount: 金额 (USDC). 需配置 BOLLOON_TREASURY_* 环境变量 (RPC/合约/私钥).',
    parameters: { agent_address: '收款 Agent 钱包地址 (必填)', amount: '金额 USDC (必填)', service: '服务名 (可选, Policy 校验用)' },
    execute: async (args) => {
      const cfg = treasuryConfigFromEnv();
      if (!cfg.rpcUrl || !cfg.treasuryAddress || !cfg.privateKey) {
        return { success: false, error: '未配置 Treasury (BOLLOON_TREASURY_RPC/ADDRESS/KEY/TOKEN)' };
      }
      const agentAddress = String(args.agent_address || '').trim();
      const amount = Number(args.amount);
      if (!agentAddress || !amount || amount <= 0) return { success: false, error: 'agent_address 和 amount(>0) 必填' };
      try {
        const { treasuryPay } = await import('./treasury-bridge.js');
        const r = await treasuryPay(cfg as any, {
          agentAddress,
          amount,
          service: String(args.service || '').trim() || undefined,
        });
        if (!r.success) return { success: false, error: r.error };
        return { success: true, output: `✅ Treasury 已支付 ${amount} USDC → ${agentAddress.slice(0, 10)}... tx=${r.txHash}` };
      } catch (e: any) {
        return { success: false, error: `treasury_pay 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  ctx.tools.set('treasury_status', {
    name: 'treasury_status',
    description: '查询 Treasury 状态 (余额/日限/冻结). 需配置 BOLLOON_TREASURY_* 环境变量.',
    parameters: {},
    execute: async () => {
      const cfg = treasuryConfigFromEnv();
      if (!cfg.rpcUrl || !cfg.treasuryAddress) {
        return { success: false, error: '未配置 Treasury (BOLLOON_TREASURY_RPC/ADDRESS)' };
      }
      try {
        const { treasuryStatus } = await import('./treasury-bridge.js');
        const s = await treasuryStatus(cfg as any);
        if (!s.ok) return { success: false, error: s.error };
        return { success: true, output: `Treasury:\n  余额: ${s.balance} USDC\n  日限: ${s.dailyLimit} USDC\n  冻结: ${s.frozen ? '是' : '否'}` };
      } catch (e: any) {
        return { success: false, error: `treasury_status 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // ============================================================
  // publish_did (2026-08-03) — 把当前 agent 的 DID 发布到 IPFS + IPNS
  // 全自动: 自动安装/启动本地 Kubo → 上传 DID 文档 → 发布 IPNS name
  // 实现: @diap/sdk (AgentAuthManager + publishAfterUpload)
  // ============================================================
  ctx.tools.set('publish_did', {
    name: 'publish_did',
    description: '把当前 agent 的 DID 身份发布到本地 IPFS + IPNS (自动安装启动 Kubo). 返回 DID + CID (IPFS 内容地址) + IPNS name (稳定可解析标识). 跨节点发现和身份解析依赖它.',
    parameters: {
      name: '可选: 发布显示名 (默认 agentId)',
    },
    execute: async (args) => {
      try {
        const agentId = String((ctx as any).agentId || '').trim();
        const { loadOrCreateAgentIdentity } = await import('./agent-identity.js');
        const identity = loadOrCreateAgentIdentity(agentId || 'default-agent');
        const { KeyManager } = await import('@diap/sdk');
        const kp = KeyManager.fromPrivateKey(Buffer.from(identity.privateKey, 'hex'));
        const displayName = args.name ? String(args.name) : agentId || 'bolloon-agent';

        // 1. 确保本地 Kubo (自动安装 + 启动)
        const sdk = await import('@diap/sdk');
        const checkKuboSetup = (sdk as any).checkKuboSetup;
        if (typeof checkKuboSetup === 'function') {
          const setup = await checkKuboSetup(true, true);
          if (!setup?.ready || !setup?.daemonRunning) {
            return { success: false, error: '本地 Kubo 不可用 (自动安装失败), 无法发布到 IPFS' };
          }
        }

        // 2. 注册 agent → 上传 DID 文档 → CID
        const { AgentAuthManager } = await import('@diap/sdk');
        const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
        const result = await auth.registerAgent({ name: displayName, services: [] }, kp, '');
        const cid = (result as any).cid || (result as any).didDocCid;
        if (!cid) return { success: false, error: 'DID 上传成功但未拿到 CID' };

        // 3. 发布 IPNS name (稳定标识)
        let ipnsName = '';
        try {
          const ipfs = await (sdk as any).IpfsClient.newWithRemoteNode('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
          // 2026-08-06 fix: 之前传 kp (KeyPair 对象) 当 keyName → ensureKeyExists 拿对象比
          //   字符串永远 false → key/gen 自动生成名为 "[object Object]" 的 key.
          //   改用确定性 key 名 (与 did-builder.ts 一致: did-<did 冒号转横线>).
          const keyName = `did-${String(identity.did || '').replace(':', '-').replace(' ', '')}` || 'self';
          const pub = await ipfs.publishAfterUpload?.(cid, keyName);
          ipnsName = pub?.name || pub?.ipnsName || '';
        } catch { /* IPNS 失败不致命, CID 仍可用 */ }

        // 2026-08-06: 发布诊断 — 节点地址 + 公网可达性提示 (IPNS 记录进 DHT 但内容拉取依赖源节点可达)
        let diag = '';
        try {
          const id = await kuboApi('/api/v0/id');
          const addrs = (id as any)?.Addresses || [];
          const pubAddrs = addrs.filter((a: string) => !/127\.0\.0\.1|::1|10\.|100\.|192\.168|172\.(1[6-9]|2\d|3[01])\./.test(a));
          const peers = await kuboApi('/api/v0/swarm/peers');
          const peerCount = (peers as any)?.Peers?.length || 0;
          diag = `\n  [诊断] 节点在线, ${peerCount} peers; 公网可达地址 ${pubAddrs.length} 个${pubAddrs.length === 0 ? ' ⚠️ 无公网地址 (NAT 后), 公网用户只能解析 IPNS 但拉不到内容, 建议 pin 到公共服务或配置端口映射' : ''}`;
        } catch { /* 诊断失败静默 */ }

        return {
          success: true,
          output: `✅ DID 已发布到 IPFS:\n  DID: ${identity.did}\n  CID: ${cid}\n  IPNS: ${ipnsName || '(发布失败, CID 仍可用)'}\n  读回验证: curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=${cid}"${diag}`,
        };
      } catch (e) {
        return { success: false, error: `publish_did 失败: ${String(e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // IPFS / IPNS 通用工具 (2026-08-04) — 查询 + 发布给 agent
  // 依赖本地 Kubo (自动安装/启动), 复用 publish_did 的 checkKuboSetup
  // ============================================================
  ctx.tools.set('ipfs_add', {
    name: 'ipfs_add',
    description: '上传文本内容到本地 IPFS (Kubo), 返回 CID. 适合把任意内容/笔记/数据发布到去中心化网络, 之后可用 ipfs_cat 读回、ipns_publish 绑定稳定标识. 自动安装/启动本地 Kubo.',
    parameters: { content: '要上传的内容 (必填)', name: '可选: 文件名/标签' },
    execute: async (args) => {
      try {
        const content = String(args.content ?? '').trim();
        if (!content) return { success: false, error: 'content 必填' };
        await ensureKuboReady();
        const sdk = await import('@diap/sdk');
        const ipfs = await (sdk as any).IpfsClient.newWithRemoteNode('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
        const r = await ipfs.upload(content, args.name ? String(args.name) : 'data');
        return { success: true, output: `✅ 已上传到 IPFS:\n  CID: ${r.cid}\n  size: ${r.size} bytes\n  读回: ipfs_cat(cid="${r.cid}")\n  绑定稳定标识: ipns_publish(cid="${r.cid}")` };
      } catch (e: any) {
        return { success: false, error: `ipfs_add 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ipfs_cat', {
    name: 'ipfs_cat',
    description: '按 CID 从本地 IPFS (Kubo) 读取内容. 参数 cid 可以是 ipfs_add 的返回 CID, 也可以是 ipns_resolve 解析出的 CID.',
    parameters: { cid: 'IPFS CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        await ensureKuboReady();
        const text = await kuboApi(`/api/v0/cat?arg=${encodeURIComponent(cid)}`);
        const s = String(text ?? '');
        return { success: true, output: `📄 ${cid} (${s.length} 字符):\n${s.slice(0, 4000)}${s.length > 4000 ? '\n...(截断)' : ''}` };
      } catch (e: any) {
        return { success: false, error: `ipfs_cat 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ipfs_ls', {
    name: 'ipfs_ls',
    description: '列出 IPFS CID 下的目录内容 (Kubo). 适用于 CID 指向目录 (如 ipfs_add 上传带 name 或 DID 文档目录) 时查看子项.',
    parameters: { cid: 'IPFS CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        await ensureKuboReady();
        const r = await kuboApi(`/api/v0/ls?arg=${encodeURIComponent(cid)}`);
        const objs = (r as any)?.Objects || [];
        const obj = objs[0];
        const links = obj?.Links || [];
        if (links.length === 0 && obj?.Type === 2) {
          return { success: true, output: `📄 ${cid} 是单个文件 (${obj.Size ?? '?'} bytes), 不是目录` };
        }
        const lines = links.map((l: any) => `  ${l.Type === 1 ? '📁' : '📄'} ${l.Name}  ${l.Size} bytes  ${l.Hash}`);
        return { success: true, output: `📂 ${cid} (${links.length} 项):\n${lines.join('\n') || '  (空目录)'}` };
      } catch (e: any) {
        return { success: false, error: `ipfs_ls 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ipns_publish', {
    name: 'ipns_publish',
    description: '把 IPFS CID 发布为 IPNS name (稳定标识, 内容更新后 name 不变). 默认用 self key (agent 身份), 可指定已有 key. 发布后任何节点可用 ipns_resolve 解析该 name 得到 CID.',
    parameters: { cid: 'IPFS CID (必填, 通常是 ipfs_add 的返回)', keyName: '可选: Kubo key 名 (默认 self)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        await ensureKuboReady();
        const sdk = await import('@diap/sdk');
        const ipfs = await (sdk as any).IpfsClient.newWithRemoteNode('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
        const keyName = String(args.keyName || 'self').trim() || 'self';
        await ipfs.ensureKeyExists(keyName);
        const r = await ipfs.publishIpns(cid, keyName, '8760h', '1h');
        // 2026-08-06: 诊断 — 公网可达性提示 (IPNS 记录进 DHT, 内容拉取依赖源节点公网可达)
        let diag = '';
        try {
          const id = await kuboApi('/api/v0/id');
          const addrs = (id as any)?.Addresses || [];
          const pubAddrs = addrs.filter((a: string) => !/127\.0\.0\.1|::1|10\.|100\.|192\.168|172\.(1[6-9]|2\d|3[01])\./.test(a));
          if (pubAddrs.length === 0) {
            diag = '\n  ⚠️ [诊断] 本机无公网可达地址 (NAT 后): 其他节点能解析 IPNS 但拉不到内容. 公网访问需 pin 到公共服务 (web3.storage/Pinata) 或给本机配置公网端口映射.';
          }
        } catch { /* 诊断失败静默 */ }
        return { success: true, output: `✅ IPNS 已发布:\n  name: ${r.name}\n  value: ${r.value}\n  解析: ipns_resolve(name="${r.name}")\n  公网访问: https://ipfs.io/ipns/${r.name}${diag}` };
      } catch (e: any) {
        return { success: false, error: `ipns_publish 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ipns_resolve', {
    name: 'ipns_resolve',
    description: '解析 IPNS name 得到 IPFS CID (Kubo). name 通常是 ipns_publish 返回的 name 或 k51... 形式的 IPNS 标识, 也可以是完整 /ipns/<name> 路径. 注意: 首次解析需查 DHT, 最长约 60 秒; 同一 name 重发布后本地缓存可能返回旧 CID, 等待传播后重试.',
    parameters: { name: 'IPNS name (必填, 如 k51qzi5uqu5d... 或 /ipns/k51...)' },
    execute: async (args) => {
      try {
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'name 必填' };
        await ensureKuboReady();
        // 2026-08-06 fix: 加 recursive+nocache — 之前不带 nocache, 同一 key 重发布后
        //   Kubo 返回本地缓存旧 CID (TTL 1h), 实测新内容发布后 resolve 到旧值.
        const r = await kuboApi(`/api/v0/name/resolve?arg=${encodeURIComponent(name)}&recursive=true&nocache=true`, undefined, 60000);
        const path = typeof r === 'object' && r !== null ? (r as any).Path : String(r);
        const cid = String(path).replace(/^\/ipfs\//, '').trim();
        return { success: true, output: `🔗 ${name} → ${path}\n  CID: ${cid}` };
      } catch (e: any) {
        return { success: false, error: `ipns_resolve 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  // ============================================================
  // bolloon_config_get / bolloon_config_set (2026-08-07)
  // Bolloon 自己读写 ~/.bolloon/bolloon-config.json — 统一配置文件,
  // 让 agent 有修改自身配置的权限 (模型/供应商/温度等), 不再只能靠用户手改.
  // ============================================================
  ctx.tools.set('bolloon_config_get', {
    name: 'bolloon_config_get',
    description: '读取 Bolloon 自身配置 (~/.bolloon/bolloon-config.json): 当前激活供应商 + 各供应商 API 配置 (baseUrl/model/温度). 注意: 不输出 apiKey 明文 (脱敏), 只显示是否已配置.',
    parameters: {},
    execute: async () => {
      try {
        const { llmConfigStore } = await import('../llm/config-store.js');
        await llmConfigStore.initialize();
        const cfg = await llmConfigStore.getConfig();
        const active = cfg.activeProvider;
        const lines: string[] = [`📋 Bolloon 配置 (${active} 激活):`];
        for (const [name, p] of Object.entries(cfg.providers || {})) {
          const pc = p as any;
          if (!pc) continue;
          const mark = name === active ? '●' : '○';
          const key = pc.apiKey ? '🔑' : pc.requiresApiKey ? '✗ 无key' : '无key需求';
          lines.push(`  ${mark} ${name}: ${key} · model=${pc.model || '?'} · baseUrl=${pc.baseUrl || '?'}${pc.temperature ? ` · temp=${pc.temperature}` : ''}`);
        }
        return { success: true, output: lines.join('\n') };
      } catch (e: any) {
        return { success: false, error: `bolloon_config_get 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('bolloon_config_set', {
    name: 'bolloon_config_set',
    description: '修改 Bolloon 自身配置 (~/.bolloon/bolloon-config.json). 可切换激活供应商 (provider) 或改某供应商的 model/baseUrl/temperature/enabled. 修改立即生效 (下次 LLM 调用使用新配置). 例: provider=deepseek; provider=minimax, model=MiniMax-M3; deepseek.temperature=0.3',
    parameters: {
      provider: '可选: 切换激活供应商 (如 deepseek / minimax / openai / anthropic / ollama)',
      'provider.key': '可选: 修改指定供应商字段, 格式 <供应商>.<字段>=<值>, 如 minimax.model=MiniMax-M3',
      model: '可选: 同时设置激活供应商的 model',
      temperature: '可选: 同时设置激活供应商的 temperature (0-2)',
    },
    execute: async (args) => {
      try {
        const { llmConfigStore } = await import('../llm/config-store.js');
        await llmConfigStore.initialize();
        const changes: string[] = [];

        // 1. 切换激活供应商
        if (args.provider) {
          const name = String(args.provider).trim().toLowerCase();
          const known = ['openai', 'anthropic', 'ollama', 'openrouter', 'gemini', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok', 'local'];
          if (!known.includes(name)) return { success: false, error: `未知供应商: ${name}. 可用: ${known.join(', ')}` };
          await llmConfigStore.setActiveProvider(name as any);
          changes.push(`activeProvider=${name}`);
        }
        // 2. 修改指定供应商字段 (provider.key=value)
        for (const [k, v] of Object.entries(args)) {
          if (k === 'provider' || k === 'model' || k === 'temperature') continue;
          if (!k.includes('.')) continue;
          const [prov, field] = k.split('.');
          const val = String(v);
          if (field === 'temperature' || field === 'maxTokens') {
            const num = Number(val);
            if (Number.isNaN(num)) return { success: false, error: `${k}=${val} 不是数字` };
            await llmConfigStore.updateProvider(prov as any, { [field]: num } as any);
          } else if (field === 'enabled') {
            await llmConfigStore.updateProvider(prov as any, { enabled: val === 'true' || val === '1' } as any);
          } else if (field === 'apiKey') {
            await llmConfigStore.updateProvider(prov as any, { apiKey: val } as any);
          } else {
            await llmConfigStore.updateProvider(prov as any, { [field]: val } as any);
          }
          changes.push(`${prov}.${field}=${field === 'apiKey' ? '***' : val}`);
        }
        // 3. 激活供应商的 model / temperature
        if (args.model || args.temperature) {
          const active = await llmConfigStore.getActiveProvider();
          const patch: any = {};
          if (args.model) patch.model = String(args.model);
          if (args.temperature) {
            const t = Number(args.temperature);
            if (Number.isNaN(t)) return { success: false, error: `temperature=${args.temperature} 不是数字` };
            patch.temperature = t;
          }
          await llmConfigStore.updateProvider(active, patch);
          if (args.model) changes.push(`${active}.model=${args.model}`);
          if (args.temperature) changes.push(`${active}.temperature=${args.temperature}`);
        }
        if (changes.length === 0) return { success: false, error: '没有要修改的配置项. 例: provider=deepseek 或 minimax.model=MiniMax-M3' };
        const cfg = await llmConfigStore.getConfig();
        return { success: true, output: `✅ 配置已更新: ${changes.join(', ')}\n  当前激活: ${cfg.activeProvider}` };
      } catch (e: any) {
        return { success: false, error: `bolloon_config_set 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });
}

// ─── IPFS/IPNS 通用 helper (2026-08-04) ─────────────────────────────────────
// 复用 publish_did 的 checkKuboSetup 自动安装/启动本地 Kubo (darwin-arm64 v0.28.0)

async function ensureKuboReady(): Promise<void> {
  const sdk = await import('@diap/sdk');
  const checkKuboSetup = (sdk as any).checkKuboSetup;
  if (typeof checkKuboSetup === 'function') {
    const setup = await checkKuboSetup(true, true);
    if (!setup?.ready || !setup?.daemonRunning) {
      throw new Error('本地 Kubo 不可用 (自动安装失败), 无法访问 IPFS');
    }
  }
}

/** Kubo HTTP API helper (POST only, 2026-08-03 实测 Kubo 只接受 POST). 2026-08-06 export 供 CLI /ipfs /ipns 命令用. */
export async function kuboApi(pathAndQuery: string, init?: RequestInit, timeoutMs = 30000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `http://127.0.0.1:5001${pathAndQuery}`;
    const resp = await fetch(url, { method: 'POST', signal: controller.signal, ...(init || {}) });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Kubo API ${pathAndQuery.split('?')[0]} 失败: ${resp.status} ${text.slice(0, 200)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) return resp.json();
    return resp.text();
  } finally {
    clearTimeout(timer);
  }
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

  // 2026-08-06: 注册 OrbitDB/CID 数据层工具 (cid_save/load/update/version/list/share + context 快照 + UI CID)
  try {
    import('../orbitdb/agent-tools.js').then(({ registerOrbitdbTools }) => {
      registerOrbitdbTools(ctx);
    }).catch((e) => {
      console.warn('[registerTools] OrbitDB 工具注册失败 (非致命):', e);
    });
  } catch (odbErr) {
    console.warn('[registerTools] OrbitDB 工具注册失败 (非致命):', odbErr);
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
