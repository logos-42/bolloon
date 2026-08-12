/**
 * Pi MCP Adapter Integration for Bolloon
 *
 * Bridges MCP (Model Context Protocol) servers with Bolloon's tool system.
 * Based on the pi-mcp-adapter philosophy: on-demand tool loading with minimal token overhead.
 *
 * 2026-08-03 (验证修复): sendMcpRequest 从 simulated 占位 → 真实 stdio JSON-RPC 通信.
 *   - 协议: initialize → notifications/initialized → tools/list → tools/call
 *   - 请求/响应按 id 配对, 30s 超时, server 崩溃时 pending 全部 reject
 *   - discoverMcpServers 修复重复读 mcpServers 键 (同一个键被读两遍)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';

// MCP server configuration
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 传输类型: stdio (默认, command 启动子进程) | http (远程 streamable HTTP) */
  type?: 'stdio' | 'http';
  /** http 类型必填: MCP 端点 URL */
  url?: string;
  /** http 类型可选: 每次请求携带的 headers (如 Authorization: Bearer xxx) */
  headers?: Record<string, string>;
}

/** streamable HTTP 传输的浏览器 UA — Cloudflare MCP 等端点有 1010 风控, node fetch 默认 UA 会被拒 */
const MCP_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Discovered MCP tool
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

// MCP protocol types (simplified)
export interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface McpServerState {
  config: McpServerConfig;
  process: ChildProcess | null;
  running: boolean;
  /** http 传输的会话 id (服务器返回 Mcp-Session-Id 时记录, 后续请求携带) */
  sessionId?: string;
  /** 按 id 挂起的请求 (响应配对) */
  pending: Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

// MCP adapter state
let tools: Map<string, McpTool> = new Map();
let servers: Map<string, McpServerState> = new Map();
let initialized = false;
let toolCallLog: Array<{ timestamp: string; tool: string; args: unknown; result: unknown }> = [];

// Event emitter for MCP events
class McpEventEmitter extends EventEmitter {}
const mcpEvents = new McpEventEmitter();

const MCP_REQUEST_TIMEOUT_MS = 30_000;
let mcpRequestSeq = 1;

/**
 * Discover MCP servers from standard config locations
 */
export async function discoverMcpServers(): Promise<McpServerConfig[]> {
  const configs: McpServerConfig[] = [];

  const locations = [
    path.join(process.env.HOME || '/tmp', '.mcp.json'),
    path.join(process.env.HOME || '/tmp', '.config', 'mcp', 'mcp.json'),
    path.join(process.env.HOME || '/tmp', '.config', 'mcp.json'),
    '.mcp.json',
  ];

  for (const loc of locations) {
    try {
      const content = await fs.readFile(loc, 'utf-8');
      const mcpJson = JSON.parse(content);

      // 2026-08-03 fix: mcpServers 只读一次 (之前 if + if['mcpServers'] 重复读同一键)
      const serversConfig = (mcpJson.mcpServers ?? mcpJson['mcpServers']) as Record<string, unknown> | undefined;
      if (serversConfig && typeof serversConfig === 'object') {
        for (const [name, config] of Object.entries(serversConfig)) {
          const serverConfig = config as Record<string, unknown>;
          if (!serverConfig || typeof serverConfig !== 'object') continue;
          // 2026-08-12: 支持 HTTP transport (type: "http" + url + headers), 如 Cloudflare MCP
          const isHttp = serverConfig.type === 'http' || (typeof serverConfig.url === 'string' && typeof serverConfig.command !== 'string');
          if (isHttp) {
            if (typeof serverConfig.url !== 'string' || !serverConfig.url) continue;
            configs.push({
              name,
              type: 'http',
              url: serverConfig.url,
              command: '',
              headers: serverConfig.headers as Record<string, string> | undefined,
            });
            continue;
          }
          if (typeof serverConfig.command !== 'string') continue;
          configs.push({
            name,
            command: serverConfig.command,
            args: Array.isArray(serverConfig.args) ? (serverConfig.args as string[]) : undefined,
            env: serverConfig.env as Record<string, string> | undefined,
          });
        }
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  // 去重 (同 name 同 command/url)
  const seen = new Set<string>();
  return configs.filter((c) => {
    const key = `${c.name}::${c.type === 'http' ? c.url : c.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Initialize the MCP adapter
 */
export async function initializeMcpAdapter(): Promise<void> {
  if (initialized) return;

  const discoveredServers = await discoverMcpServers();
  console.log(`[McpAdapter] Discovered ${discoveredServers.length} MCP servers`);

  for (const server of discoveredServers) {
    registerServer(server);
    // 2026-08-03: 启动后立即握手 + 发现工具 (真实 stdio 协议)
    await connectAndDiscover(server.name).catch((e) => {
      console.warn(`[McpAdapter] connect ${server.name} 失败:`, e?.message?.slice(0, 120));
    });
  }

  initialized = true;
  mcpEvents.emit('initialized');
}

/**
 * 连接 MCP server + 握手 + 发现并注册工具 (2026-08-03)
 * 协议序: startServer → initialize → notifications/initialized → tools/list
 */
export async function connectAndDiscover(serverName: string): Promise<McpTool[]> {
  const server = servers.get(serverName);
  if (!server) return [];

  if (!server.running || !server.process) {
    const started = await startServer(serverName);
    if (!started) return [];
    // http 传输无进程, 无需等待就绪; stdio 等 server 启动
    if (server.config.type !== 'http') {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  await sendMcpRequest(serverName, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bolloon', version: '0.3.27' },
  });
  await sendMcpRequest(serverName, 'notifications/initialized');

  const result = await sendMcpRequest(serverName, 'tools/list');
  const toolsList = Array.isArray((result as any)?.tools) ? (result as any).tools : [];

  const discovered: McpTool[] = [];
  for (const t of toolsList) {
    const tool: McpTool = {
      name: String(t.name || ''),
      description: String(t.description || ''),
      inputSchema: (t.inputSchema as Record<string, unknown>) || {},
      serverName,
    };
    if (!tool.name) continue;
    discovered.push(tool);
    registerTool(tool);
  }
  console.log(`[McpAdapter] ${serverName}: 发现 ${discovered.length} 个工具 (${discovered.map((t) => t.name).join(', ')})`);
  return discovered;
}

/**
 * Register an MCP server configuration
 */
export function registerServer(config: McpServerConfig): void {
  if (servers.has(config.name)) return;
  servers.set(config.name, { config, process: null, running: false, pending: new Map() });
  console.log(`[McpAdapter] Registered server: ${config.name}`);
}

/**
 * Register an MCP tool
 */
export function registerTool(tool: McpTool): void {
  tools.set(tool.name, tool);
  mcpEvents.emit('toolRegistered', tool);
}

/**
 * List all available MCP tools
 */
export function listTools(): McpTool[] {
  return Array.from(tools.values());
}

/**
 * Check if a tool exists
 */
export function hasTool(name: string): boolean {
  return tools.has(name);
}

/**
 * Get a specific tool
 */
export function getTool(name: string): McpTool | undefined {
  return tools.get(name);
}

/**
 * Get tool call log for debugging
 */
export function getToolCallLog(): Array<{ timestamp: string; tool: string; args: unknown; result: unknown }> {
  return [...toolCallLog];
}

/**
 * Clear tool call log
 */
export function clearToolCallLog(): void {
  toolCallLog = [];
}

/**
 * Execute an MCP tool via JSON-RPC protocol
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; content?: unknown[]; error?: string }> {
  const tool = tools.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  const server = servers.get(tool.serverName);
  if (!server) {
    return { success: false, error: `Server not found: ${tool.serverName}` };
  }

  // Log the call for debugging
  const logEntry = {
    timestamp: new Date().toISOString(),
    tool: name,
    args,
    result: null as unknown,
  };

  console.log(`[McpAdapter] Executing tool: ${name} with args:`, JSON.stringify(args, null, 2));

  try {
    const result = await sendMcpRequest(tool.serverName, 'tools/call', {
      name,
      arguments: args,
    });

    logEntry.result = result;
    toolCallLog.push(logEntry);

    // Keep log size manageable
    if (toolCallLog.length > 100) {
      toolCallLog = toolCallLog.slice(-50);
    }

    if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
      // 2026-08-03: 提取 content 数组里的文本 (agent 直接可用)
      const content = (result as { content: Array<{ type?: string; text?: string }> }).content;
      const text = Array.isArray(content)
        ? content.map((c) => c?.text ?? '').filter(Boolean).join('\n')
        : JSON.stringify(result);
      return { success: true, content: [{ type: 'text', text }] };
    }

    return { success: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    logEntry.result = { error: String(e) };
    toolCallLog.push(logEntry);
    return { success: false, error: String(e) };
  }
}

/**
 * Send MCP request to a server via real stdio JSON-RPC (2026-08-03).
 * - 写 JSON-RPC 行到 server stdin, 从 stdout 按 id 配对响应
 * - 30s 超时; server 进程退出时挂起请求全部 reject
 */
async function sendMcpRequest(
  serverName: string,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const server = servers.get(serverName);
  if (!server) {
    throw new Error(`Server not registered: ${serverName}`);
  }

  // 2026-08-12: http 传输走 fetch JSON-RPC (streamable HTTP)
  if (server.config.type === 'http') {
    return sendHttpMcpRequest(serverName, method, params);
  }

  // 确保 server 进程在跑
  if (!server.running || !server.process || !server.process.stdin?.writable) {
    const started = await startServer(serverName);
    if (!started) throw new Error(`无法启动 MCP server: ${serverName}`);
    // 等 500ms 让 server 就绪
    await new Promise((r) => setTimeout(r, 500));
  }
  const child = server.process!;
  if (!child.stdin?.writable) throw new Error(`MCP server stdin 不可写: ${serverName}`);

  const id = mcpRequestSeq++;
  const isNotification = method.startsWith('notifications/');
  // 通知 (notifications/*) 是 fire-and-forget: 无 id, server 不响应
  const line = JSON.stringify(
    isNotification
      ? { jsonrpc: '2.0', method, params: params ?? {} }
      : { jsonrpc: '2.0', id, method, params: params ?? {} }
  );

  if (isNotification) {
    child.stdin!.write(line + '\n');
    return undefined;
  }

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`MCP request timeout (${MCP_REQUEST_TIMEOUT_MS}ms): ${method}`));
    }, MCP_REQUEST_TIMEOUT_MS);

    server.pending.set(id, { resolve, reject, timer });
    child.stdin!.write(line + '\n');
  });
}

/**
 * Send MCP request to a remote server via streamable HTTP (2026-08-12).
 * - POST JSON-RPC 到 url, 携带 Authorization 等配置 headers
 * - 默认带浏览器 UA (Cloudflare MCP 1010 风控, node fetch 默认 UA 被拒)
 * - 响应支持 application/json 与 text/event-stream (SSE) 两种格式
 * - 服务器返回 Mcp-Session-Id 时记录, 后续请求自动携带
 * - 通知 (notifications/*) fire-and-forget: 不等待响应体 (Cloudflare 返回 202)
 */
async function sendHttpMcpRequest(
  serverName: string,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const server = servers.get(serverName);
  if (!server) throw new Error(`Server not registered: ${serverName}`);
  if (!server.config.url) throw new Error(`MCP http server 缺 url: ${serverName}`);

  const id = mcpRequestSeq++;
  const isNotification = method.startsWith('notifications/');
  const payload = isNotification
    ? { jsonrpc: '2.0' as const, method, params: params ?? {} }
    : { jsonrpc: '2.0' as const, id, method, params: params ?? {} };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(server.config.headers ?? {}),
  };
  // 1010 风控: 默认浏览器 UA, 用户 headers 可覆盖
  if (!headers['User-Agent']) headers['User-Agent'] = MCP_BROWSER_UA;
  if (server.sessionId) headers['Mcp-Session-Id'] = server.sessionId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MCP_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(server.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (isNotification) {
      // fire-and-forget: 不等 body (Cloudflare 返回 202 空体)
      res.body?.cancel().catch(() => {});
      return undefined;
    }

    const sessionId = res.headers.get('Mcp-Session-Id');
    if (sessionId) server.sessionId = sessionId;

    const raw = await res.text();
    const ct = res.headers.get('content-type') || '';
    let msg: McpResponse;
    if (ct.includes('text/event-stream') || raw.trimStart().startsWith('event:')) {
      msg = parseSseMessage(raw);
    } else {
      msg = JSON.parse(raw) as McpResponse;
    }
    if (msg.error) {
      throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    }
    return msg.result;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 SSE 响应 (event: message\n data: {...}\n\n 可多块), 取所有 data: 行拼接 JSON */
function parseSseMessage(raw: string): McpResponse {
  let data = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) {
    throw new Error(`SSE 响应无 data 块: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(data) as McpResponse;
}

/** 挂上 stdout 行读取器 (按 id 分发响应) */
function attachStdoutReader(serverName: string, child: ChildProcess): void {
  const server = servers.get(serverName);
  if (!server) return;

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: McpResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.log(`[McpAdapter][${serverName}] non-JSON stdout:`, trimmed.slice(0, 200));
      return;
    }
    // 服务端主动推送 (无 id) → 忽略
    if (msg.id === undefined || msg.id === null) return;
    const entry = server.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    server.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  });
}

/**
 * Start an MCP server process
 */
export async function startServer(serverName: string): Promise<boolean> {
  const server = servers.get(serverName);
  if (!server) {
    console.error(`[McpAdapter] Server not found: ${serverName}`);
    return false;
  }

  if (server.running && server.process) {
    return true;
  }

  // 2026-08-12: http 传输无子进程 — 虚拟 running, 请求走 sendHttpMcpRequest
  if (server.config.type === 'http') {
    server.running = true;
    return true;
  }

  try {
    const child = spawn(server.config.command, server.config.args || [], {
      env: { ...process.env, ...server.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data) => {
      console.log(`[McpAdapter][${serverName}] stdout:`, data.toString());
    });

    child.stderr?.on('data', (data) => {
      console.error(`[McpAdapter][${serverName}] stderr:`, data.toString());
    });

    child.on('error', (err) => {
      console.error(`[McpAdapter][${serverName}] error:`, err);
      rejectAllPending(server, `MCP server process error: ${err.message}`);
      server.running = false;
      server.process = null;
    });

    child.on('exit', (code) => {
      console.log(`[McpAdapter][${serverName}] exited with code:`, code);
      rejectAllPending(server, `MCP server exited with code ${code}`);
      server.running = false;
      server.process = null;
    });

    server.process = child;
    server.running = true;
    // 2026-08-03: 挂 stdout 行读取器, 按 id 分发 JSON-RPC 响应
    attachStdoutReader(serverName, child);
    console.log(`[McpAdapter] Started server: ${serverName}`);
    return true;
  } catch (e) {
    console.error(`[McpAdapter] Failed to start ${serverName}:`, e);
    return false;
  }
}

/** server 退出时把挂起请求全部 reject, 避免调用方永远等待 */
function rejectAllPending(server: McpServerState, reason: string): void {
  for (const [, entry] of server.pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  server.pending.clear();
}

/**
 * Stop an MCP server
 */
export function stopServer(serverName: string): void {
  const server = servers.get(serverName);
  if (server && server.process) {
    server.process.kill();
    server.running = false;
    server.process = null;
    console.log(`[McpAdapter] Stopped server: ${serverName}`);
  }
}

/**
 * Discover tools from a server using MCP protocol
 */
export async function discoverTools(serverName: string): Promise<McpTool[]> {
  try {
    const result = await sendMcpRequest(serverName, 'tools/list');
    const toolsList: McpTool[] = [];

    if (result && typeof result === 'object' && 'tools' in (result as Record<string, unknown>)) {
      const toolsData = (result as { tools: unknown[] }).tools;
      for (const tool of toolsData) {
        const t = tool as Record<string, unknown>;
        toolsList.push({
          name: t.name as string,
          description: (t.description as string) || '',
          inputSchema: (t.inputSchema as Record<string, unknown>) || {},
          serverName,
        });
      }
    }

    return toolsList;
  } catch (e) {
    console.error(`[McpAdapter] Failed to discover tools from ${serverName}:`, e);
    return [];
  }
}

/**
 * Create a Tavily search tool (common MCP integration)
 */
export function createTavilyTool(apiKey: string): McpTool {
  return {
    name: 'tavily_search',
    description: 'Search the web using Tavily',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Maximum results', default: 5 },
      },
      required: ['query'],
    },
    serverName: 'tavily',
  };
}

/**
 * Create an Amap maps tool
 */
export function createAmapTool(apiKey: string): McpTool {
  return {
    name: 'amap_weather',
    description: 'Get weather information from Amap',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name or code' },
      },
      required: ['city'],
    },
    serverName: 'amap-maps',
  };
}

/**
 * Get adapter status
 */
export function getAdapterStatus(): {
  initialized: boolean;
  serverCount: number;
  toolCount: number;
  servers: string[];
  runningServers: string[];
} {
  return {
    initialized,
    serverCount: servers.size,
    toolCount: tools.size,
    servers: Array.from(servers.keys()),
    runningServers: Array.from(servers.entries())
      .filter(([, s]) => s.running)
      .map(([name]) => name),
  };
}

/**
 * Event subscription
 */
export function on(event: 'initialized' | 'toolRegistered', callback: (...args: unknown[]) => void): void {
  mcpEvents.on(event, callback);
}

export function off(event: 'initialized' | 'toolRegistered', callback: (...args: unknown[]) => void): void {
  mcpEvents.off(event, callback);
}