/**
 * Pi MCP Adapter Integration for Bolloon
 *
 * Bridges MCP (Model Context Protocol) servers with Bolloon's tool system.
 * Based on the pi-mcp-adapter philosophy: on-demand tool loading with minimal token overhead.
 *
 * Key differences from Claude Code MCP:
 * - White-box design: every schema, parameter, and return value is visible
 * - Minimal primitives: only read, write, edit, bash under the hood
 * - No schema validation black boxes - interfaces are simple by design
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// MCP server configuration
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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

// MCP adapter state
let tools: Map<string, McpTool> = new Map();
let servers: Map<string, { config: McpServerConfig; process: ChildProcess | null; running: boolean }> = new Map();
let initialized = false;
let toolCallLog: Array<{ timestamp: string; tool: string; args: unknown; result: unknown }> = [];

// Event emitter for MCP events
class McpEventEmitter extends EventEmitter {}
const mcpEvents = new McpEventEmitter();

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

      if (mcpJson.mcpServers) {
        for (const [name, config] of Object.entries(mcpJson.mcpServers)) {
          const serverConfig = config as Record<string, unknown>;
          configs.push({
            name,
            command: serverConfig.command as string,
            args: serverConfig.args as string[],
            env: serverConfig.env as Record<string, string>,
          });
        }
      }

      if (mcpJson['mcpServers']) {
        for (const [name, config] of Object.entries(mcpJson['mcpServers'])) {
          const serverConfig = config as Record<string, unknown>;
          configs.push({
            name,
            command: serverConfig.command as string,
            args: serverConfig.args as string[],
            env: serverConfig.env as Record<string, string>,
          });
        }
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  return configs;
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
  }

  initialized = true;
  mcpEvents.emit('initialized');
}

/**
 * Register an MCP server configuration
 */
export function registerServer(config: McpServerConfig): void {
  servers.set(config.name, { config, process: null, running: false });
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
      return {
        success: true,
        content: (result as { content: unknown[] }).content,
      };
    }

    return { success: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    logEntry.result = { error: String(e) };
    toolCallLog.push(logEntry);
    return { success: false, error: String(e) };
  }
}

/**
 * Send MCP request to a server (simplified - uses stdin/stdout JSON-RPC)
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

  // For now, return a placeholder - real implementation would use MCP protocol
  // The actual protocol typically uses stdio or HTTP+streamableHTTP
  console.log(`[McpAdapter] Would send ${method} to ${serverName}:`, params);

  // Simulate successful response for development
  return {
    content: [
      {
        type: 'text',
        text: `[Simulated] Tool ${method} executed with params: ${JSON.stringify(params)}`,
      },
    ],
  };
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
      server.running = false;
      server.process = null;
    });

    child.on('exit', (code) => {
      console.log(`[McpAdapter][${serverName}] exited with code:`, code);
      server.running = false;
      server.process = null;
    });

    server.process = child;
    server.running = true;
    console.log(`[McpAdapter] Started server: ${serverName}`);
    return true;
  } catch (e) {
    console.error(`[McpAdapter] Failed to start ${serverName}:`, e);
    return false;
  }
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