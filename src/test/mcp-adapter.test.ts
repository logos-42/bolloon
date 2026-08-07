import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  discoverMcpServers,
  initializeMcpAdapter,
  listTools,
  executeTool,
  getAdapterStatus,
} from '../pi-ecosystem-mcp/index.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-mcp-test-${Date.now()}`);
let oldHome = '';

const ECHO_SERVER = `#!/usr/bin/env python3
import json, sys
TOOLS = [
  {"name": "echo", "description": "回显", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
  {"name": "add", "description": "相加", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}},
]
def handle(msg):
    m = msg.get("method", ""); mid = msg.get("id"); p = msg.get("params") or {}
    if m == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "echo", "version": "1"}}}
    if m == "notifications/initialized":
        return None
    if m == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if m == "tools/call":
        name = p.get("name"); a = p.get("arguments") or {}
        if name == "echo":
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "echo: " + str(a.get("text", ""))}]}}
        if name == "add":
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(float(a.get("a", 0)) + float(a.get("b", 0)))}]}}
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown tool"}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown method"}}
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: msg = json.loads(line)
    except Exception: continue
    resp = handle(msg)
    if resp is not None:
        sys.stdout.write(json.dumps(resp) + "\\n"); sys.stdout.flush()
`;

describe('mcp-adapter (真实 stdio JSON-RPC, 2026-08-03 修复后)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    // 写 MCP server 脚本
    const serverPath = path.join(tmpHome, 'echo-server.py');
    await fs.mkdir(tmpHome, { recursive: true });
    await fs.writeFile(serverPath, ECHO_SERVER, 'utf-8');
    // 写 ~/.mcp.json (故意重复 mcpServers 键值, 验证去重)
    // Windows 无 python3 (WindowsApps 存根 9009), 用跨平台探测
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const mcpJson = {
      mcpServers: {
        'echo-mcp': { command: pyCmd, args: [serverPath] },
      },
    };
    await fs.writeFile(path.join(tmpHome, '.mcp.json'), JSON.stringify(mcpJson), 'utf-8');
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('discoverMcpServers 从 ~/.mcp.json 发现 + 去重', async () => {
    const servers = await discoverMcpServers();
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe('echo-mcp');
    expect(servers[0].command).toBe(process.platform === 'win32' ? 'python' : 'python3');
  });

  it('initializeMcpAdapter → 握手 + 发现工具 (echo/add)', async () => {
    await initializeMcpAdapter();
    const status = getAdapterStatus();
    expect(status.serverCount).toBe(1);
    const tools = listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('add');
  });

  it('executeTool 真实调用 (JSON-RPC over stdio)', async () => {
    const r1 = await executeTool('echo', { text: 'hello-mcp' });
    expect(r1.success).toBe(true);
    const text1 = JSON.stringify(r1.content || '');
    expect(text1).toContain('echo: hello-mcp');

    const r2 = await executeTool('add', { a: 20, b: 22 });
    expect(r2.success).toBe(true);
    expect(JSON.stringify(r2.content || '')).toContain('42.0');
  });

  it('executeTool 未知工具 → error', async () => {
    const r = await executeTool('no_such_tool', {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('Unknown tool');
  });
});
