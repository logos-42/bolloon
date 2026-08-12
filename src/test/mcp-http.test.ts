import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  discoverMcpServers,
  initializeMcpAdapter,
  listTools,
  executeTool,
  getAdapterStatus,
} from '../pi-ecosystem-mcp/index.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-mcp-http-test-${Date.now()}`);
let oldHome = '';

/** 本地 mock streamable HTTP MCP server (SSE 响应, 与 Cloudflare MCP 同款协议) */
function startMockHttpMcp(): Promise<{ port: number; close: () => Promise<void>; seenUAs: string[]; seenAuths: string[] }> {
  const seenUAs: string[] = [];
  const seenAuths: string[] = [];
  const server = http.createServer((req, res) => {
    seenUAs.push(req.headers['user-agent'] || '');
    seenAuths.push(req.headers['authorization'] || '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg: any = {};
      try { msg = JSON.parse(body); } catch { /* noop */ }
      const method = msg.method || '';
      const mid = msg.id;

      const send = (obj: unknown) => {
        const sse = `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse);
      };

      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id: mid, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-http', version: '1' } } });
      } else if (method === 'notifications/initialized') {
        res.writeHead(202, { 'Content-Type': 'text/plain' });
        res.end();
      } else if (method === 'tools/list') {
        send({
          jsonrpc: '2.0', id: mid,
          result: {
            tools: [
              { name: 'httpecho', description: 'http 回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            ],
          },
        });
      } else if (method === 'tools/call') {
        const p = msg.params || {};
        const text = (p.arguments || {}).text || '';
        send({ jsonrpc: '2.0', id: mid, result: { content: [{ type: 'text', text: `http-echo: ${text}` }] } });
      } else {
        send({ jsonrpc: '2.0', id: mid, error: { code: -32601, message: 'unknown method' } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
        seenUAs,
        seenAuths,
      });
    });
  });
}

describe('mcp-adapter HTTP transport (streamable HTTP + SSE, 2026-08-12)', () => {
  let mock: { port: number; close: () => Promise<void>; seenUAs: string[]; seenAuths: string[] };

  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    await fs.mkdir(tmpHome, { recursive: true });
    mock = await startMockHttpMcp();

    // ~/.mcp.json: stdio + http 混合
    const mcpJson = {
      mcpServers: {
        'echo-mcp': { command: process.platform === 'win32' ? 'python' : 'python3', args: ['/nonexistent'] },
        'cloudflare-mock': {
          type: 'http',
          url: `http://127.0.0.1:${mock.port}/mcp`,
          headers: { Authorization: 'Bearer test-token-123' },
        },
      },
    };
    await fs.writeFile(path.join(tmpHome, '.mcp.json'), JSON.stringify(mcpJson), 'utf-8');
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    await mock.close();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('discoverMcpServers 解析 http 条目 (type+url+headers)', async () => {
    const servers = await discoverMcpServers();
    const httpServer = servers.find((s) => s.name === 'cloudflare-mock');
    expect(httpServer).toBeDefined();
    expect(httpServer!.type).toBe('http');
    expect(httpServer!.url).toContain('127.0.0.1');
    expect(httpServer!.headers?.Authorization).toBe('Bearer test-token-123');
    // stdio 条目不受影响
    const stdioServer = servers.find((s) => s.name === 'echo-mcp');
    expect(stdioServer!.type).toBeUndefined();
    expect(stdioServer!.command).toBeDefined();
  });

  it('initializeMcpAdapter → http 握手 + 发现工具 (SSE 响应)', async () => {
    await initializeMcpAdapter();
    const status = getAdapterStatus();
    expect(status.serverCount).toBe(2);
    const names = listTools().map((t) => t.name);
    expect(names).toContain('httpecho');
  });

  it('executeTool 走 HTTP JSON-RPC (真实 fetch)', async () => {
    const r = await executeTool('httpecho', { text: 'over-http' });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.content || '')).toContain('http-echo: over-http');
  });

  it('请求带浏览器 UA (1010 风控) + 配置的 Authorization header', () => {
    expect(mock.seenUAs.length).toBeGreaterThan(0);
    for (const ua of mock.seenUAs) {
      expect(ua).toContain('Mozilla/5.0');
    }
    for (const auth of mock.seenAuths) {
      expect(auth).toBe('Bearer test-token-123');
    }
  });
});
