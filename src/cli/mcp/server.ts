/**
 * server.ts — P4 MCP server (stdio transport, JSON-RPC 2.0)
 *
 * 位置: `bolloon mcp serve`。**只调 P3 命令/服务层** (经 `bridge.callP3`), 不复制业务逻辑。
 *
 * 三条硬规矩 (P4 任务书):
 *   ① **stdout 只走 JSON-RPC** —— 永远不往 stdout 打日志/横幅 (`bolloon mcp serve` 时 console 被改道去 stderr)。
 *   ② **失败不得变成 MCP 成功** —— tool 返回 P3 信封**原样** (含 `code`/`next_action`), 同时
 *      `isError = !ok`。客户端既可以机器分派 (`code`/`next_action`), 也能从 `isError` 看出成败。
 *      MCP 协议级错误 (未知 method / 未知 tool 名 / 未知 resource URI) 才用 JSON-RPC error。
 *   ③ **调用超时** —— 走 P3 的 `--timeout`; 超时给 `code=TIMEOUT` 的信封 (不是把错误吞掉后回成功)。
 *
 * 支持的方法: initialize · notifications/* · ping · tools/list · tools/call ·
 *             resources/list · resources/read。其它 method → JSON-RPC -32601 (不静默)。
 */

import * as readline from 'readline';
import { collectVersionInfo } from '../../utils/version-info.js';
import { callP3 } from './bridge.js';
import {
  TOOL_BY_NAME, RESOURCE_BY_URI,
  listToolsPayload, listResourcesPayload,
  type ResourcePayload,
} from './tools.js';
import type { Envelope } from '../protocol-envelope.js';

export const SERVER_NAME = 'bolloon';
/** 支持的 MCP 协议版本 (客户端请求哪个就回哪个; 都不认就回最新的) */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function serverVersion(): string {
  try {
    return collectVersionInfo({ light: true }).packageVersion || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: undefined, error: { code, message, data } };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * 处理一条 JSON-RPC 消息。
 * 返回 `null` = 这是通知 (notification), 按协议不回响应。
 * 这个方法**不写 stdout** —— 由调用方 (serveStdio) 或测试直接拿返回值。
 */
export async function handleMessage(msg: unknown): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return err(null, JSONRPC.INVALID_REQUEST, 'JSON-RPC 消息必须是对象');
  }
  const req = msg as JsonRpcRequest;
  const id = req.id === undefined ? null : req.id;
  const method = String(req.method || '');
  const params = (req.params || {}) as Record<string, unknown>;
  const isNotification = req.id === undefined;

  // 通知: 一律不响应 (protocol spec)
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const wanted = String(params.protocolVersion || '');
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(wanted) ? wanted : DEFAULT_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
        instructions:
          'Bolloon 本机 Agent Runtime 的 MCP 入口。所有 tool 都是 `bolloon <命令组> <子命令>` 的薄包装, ' +
          '返回统一信封 { ok, code, message, data, evidence, next_action } —— **判据永远是 ok/code, 不是 MCP 的 isError 之外的任何东西**; ' +
          'ok:false 表示这次调用没有成功 (含"等人工放行"这类正常态, 例如 PAYMENT_REQUIRED + approve_payment)。' +
          '★★ 链上写 tool (bolloon_chain_trade_create / submit_proof / release) 是**真签名 + 真移钱**的写操作: ' +
          '每个都必须显式携带授权意图 (paymentMode + requestId), 缺任何一个 → NOT_AUTHORIZED (fail-closed, 不默认放行); ' +
          '真签名只由本机唯一放行闸 authorizeWalletSignature 决定, MCP 层既不放行也不旁路。调用方必须自己保证已授权。' +
          '本适配层不代付款、不改交易历史、不伪造 verified、不返回私钥; 付款不确定时先 reconcile (绝不重付)。',
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: listToolsPayload() });

    case 'tools/call': {
      const name = String(params.name || '');
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        return err(id, JSONRPC.INVALID_PARAMS, `未知 tool: '${name}'`, { knownTools: Array.from(TOOL_BY_NAME.keys()) });
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
        return ok(id, toolResult({ ok: false, code: 'INVALID_ARGUMENT', message: 'arguments 必须是 JSON 对象', data: { got: typeof rawArgs }, evidence: [], next_action: 'needs_human' }));
      }
      const built = tool.build((rawArgs || {}) as Record<string, unknown>);
      const envelope: Envelope = built.ok ? await callP3(built.plan) : built.envelope;
      return ok(id, toolResult(envelope));
    }

    case 'resources/list':
      return ok(id, { resources: listResourcesPayload() });

    case 'resources/read': {
      const uri = String(params.uri || '');
      const res = RESOURCE_BY_URI.get(uri);
      if (!res) {
        return err(id, JSONRPC.INVALID_PARAMS, `未知 resource: '${uri}'`, { knownResources: Array.from(RESOURCE_BY_URI.keys()) });
      }
      let payload: ResourcePayload;
      try {
        payload = await res.load();
      } catch (e: any) {
        // 读取本身炸了 → 也必须是**结构化**的失败 (绝不假装读到)
        payload = {
          uri,
          mimeType: 'application/json',
          ok: false,
          text: JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: `resource 读取失败: ${String(e?.message || e).slice(0, 200)}`, data: { uri }, evidence: [], next_action: 'needs_human' }, null, 2),
        };
      }
      return ok(id, { contents: [{ uri: payload.uri, mimeType: payload.mimeType, text: payload.text }] });
    }

    default: {
      if (isNotification) return null;
      return err(id, JSONRPC.METHOD_NOT_FOUND, `不支持的 method: '${method}'`, { supported: ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read'] });
    }
  }
}

/**
 * `tools/call` 的结果体。
 * ★ `isError` 直接取 P3 信封的 `!ok` —— **失败绝不变成 MCP 成功**。
 * `content[0].text` = 信封原样 JSON (code / message / data / evidence / next_action 一个不改)。
 */
export function toolResult(env: Envelope) {
  const text = JSON.stringify(env, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: env,
    isError: env.ok !== true,
  };
}

export interface ServeOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 是否往 stderr 打一行就绪信息 (默认 true; stdout 永远不打) */
  announce?: boolean;
}

/**
 * stdio 事件循环: 一行一条 JSON-RPC (MCP stdio transport)。
 * 读到 stdin 结束 → 正常退出 (return 0); 解析失败的**单行**不回崩, 回 -32700 继续跑。
 */
export async function serveStdio(opts: ServeOptions = {}): Promise<number> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const write = (resp: JsonRpcResponse) => output.write(`${JSON.stringify(resp)}\n`);

  if (opts.announce !== false) {
    process.stderr.write(
      `${SERVER_NAME} mcp serve — stdio / MCP ${DEFAULT_PROTOCOL_VERSION} · tools=${TOOL_BY_NAME.size} resources=${RESOURCE_BY_URI.size} · stdout 只走 JSON-RPC\n`,
    );
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const text = String(line).trim();
    if (!text) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (e: any) {
      write(err(null, JSONRPC.PARSE_ERROR, `JSON 解析失败: ${String(e?.message || e).slice(0, 120)}`));
      continue;
    }
    // 顺序处理: 读一行 → 处理完 → 写一行。响应因此与请求**同序** (客户端按 id 配对也照样行),
    // 也不会出现两个响应交错写半行的可能 (stdout 是协议流)。
    let resp: JsonRpcResponse | null = null;
    try {
      resp = await handleMessage(msg);
    } catch (e: any) {
      resp = err((msg as JsonRpcRequest)?.id ?? null, JSONRPC.INTERNAL_ERROR, `服务内部异常: ${String(e?.message || e).slice(0, 200)}`);
    }
    if (resp) write(resp);
  }
  return 0;
}

/** 工具清单 (给 `bolloon mcp tools` 用, 也方便验收) */
export function inventory() {
  return {
    server: { name: SERVER_NAME, version: serverVersion(), protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
    tools: listToolsPayload().map((t) => ({ name: t.name, title: (t.description.match(/^\[(.*?)\]/) || [])[1] || '', params: Object.keys((t.inputSchema.properties || {}) as Record<string, unknown>) })),
    resources: listResourcesPayload(),
  };
}
