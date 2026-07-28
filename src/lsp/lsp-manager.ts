/**
 * lsp/lsp-manager.ts — LSP 服务器发现 + 生命周期管理
 *
 * 检测本机已安装的语言服务器, 管理启动/关闭,
 * 通过 JSON-RPC over stdio 与 LSP 服务器通信.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { createInterface } from 'readline';

// ==================== 类型 ====================

export interface LspServerSpec {
  /** 语言 id (typescript, python, rust, lua 等) */
  language: string;
  /** 展示名 */
  displayName: string;
  /** CLI 二进制名 */
  binary: string;
  /** 启动 argv (不包括 binary 本身) */
  args: string[];
  /** 文件扩展名 → 该 LSP 处理 */
  fileExtensions: string[];
}

export interface LspServerInstance {
  spec: LspServerSpec;
  process: ChildProcess;
  /** 下一个请求 id */
  nextId: number;
}

/** LSP JSON-RPC 请求 */
interface LspRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

/** LSP JSON-RPC 响应 */
interface LspResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ==================== 已知 LSP 服务器规格 ====================

const KNOWN_LSP_SERVERS: LspServerSpec[] = [
  {
    language: 'typescript',
    displayName: 'TypeScript Language Server',
    binary: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    language: 'rust',
    displayName: 'rust-analyzer',
    binary: 'rust-analyzer',
    args: [],
    fileExtensions: ['.rs'],
  },
  {
    language: 'python',
    displayName: 'Pyright',
    binary: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: ['.py'],
  },
  {
    language: 'css',
    displayName: 'CSS Language Server',
    binary: 'vscode-css-language-server',
    args: ['--stdio'],
    fileExtensions: ['.css', '.scss', '.less'],
  },
  {
    language: 'json',
    displayName: 'JSON Language Server',
    binary: 'vscode-json-language-server',
    args: ['--stdio'],
    fileExtensions: ['.json', '.jsonc'],
  },
];

// ==================== 服务器实例缓存 ====================

const instances = new Map<string, LspServerInstance>();

// ==================== 发现 ====================

/** 检测已安装的 LSP 服务器 (哪些二进制在 PATH 上) */
export async function detectInstalledLspServers(): Promise<LspServerSpec[]> {
  const results: LspServerSpec[] = [];
  for (const spec of KNOWN_LSP_SERVERS) {
    try {
      const exists = await checkBinary(spec.binary);
      if (exists) results.push(spec);
    } catch {
      // 静默跳过
    }
  }
  return results;
}

function checkBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${JSON.stringify(name)}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', () => resolve(out.trim().length > 0));
    p.on('error', () => resolve(false));
  });
}

// ==================== 生命周期 ====================

/** 启动一个 LSP 服务器 (如果尚未启动则启动) */
export async function startLspServer(language: string): Promise<LspServerInstance | null> {
  // 已有实例, 返回缓存
  const existing = instances.get(language);
  if (existing && existing.process.exitCode === null) return existing;

  // 查找规格
  const spec = KNOWN_LSP_SERVERS.find(s => s.language === language)
    || (await detectInstalledLspServers()).find(s => s.language === language);
  if (!spec) return null;

  // spawn 进程
  const proc = spawn(spec.binary, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const instance: LspServerInstance = { spec, process: proc, nextId: 1 };
  instances.set(language, instance);

  // 发送 initialize 请求
  await sendRequest(instance, 'initialize', {
    processId: process.pid,
    capabilities: {},
    rootUri: null,
  });

  // 发送 initialized 通知
  sendNotification(instance, 'initialized', {});

  return instance;
}

/** 关闭 LSP 服务器 */
export async function stopLspServer(language: string): Promise<void> {
  const inst = instances.get(language);
  if (!inst) return;
  try {
    sendNotification(inst, 'shutdown', {});
    sendNotification(inst, 'exit', {});
  } catch { /* ignore */ }
  setTimeout(() => {
    try { inst.process.kill('SIGKILL'); } catch { /* ignore */ }
  }, 2000).unref();
  instances.delete(language);
}

/** 关闭所有 LSP 服务器 */
export function stopAllLspServers(): void {
  for (const lang of instances.keys()) {
    stopLspServer(lang);
  }
}

// ==================== JSON-RPC 通信 ====================

function sendRequest(inst: LspServerInstance, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = inst.nextId++;
    const req: LspRequest = { jsonrpc: '2.0', id, method, params };
    const body = JSON.stringify(req);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;

    const rl = createInterface({ input: inst.process.stdout! });
    const onLine = (line: string) => {
      try {
        const resp: LspResponse = JSON.parse(line);
        if (resp.id === id) {
          rl.close();
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp.result);
        }
      } catch { /* skip non-JSON lines (content-length headers) */ }
    };

    // LSP 响应是 header + body, 先读 Content-Length 头再读 body
    let buffer = '';
    let contentLength = -1;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        if (contentLength < 0) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const headerPart = buffer.substring(0, headerEnd);
          const lenMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
          if (lenMatch) contentLength = parseInt(lenMatch[1], 10);
          buffer = buffer.substring(headerEnd + 4);
        }
        if (contentLength > 0 && buffer.length >= contentLength) {
          const bodyStr = buffer.substring(0, contentLength);
          buffer = buffer.substring(contentLength);
          contentLength = -1;
          try {
            const resp: LspResponse = JSON.parse(bodyStr);
            if (resp.id === id) {
              inst.process.stdout!.removeListener('data', onData);
              if (resp.error) reject(new Error(resp.error.message));
              else resolve(resp.result);
              return;
            }
          } catch { /* skip malformed */ }
        } else break;
      }
    };

    inst.process.stdout!.on('data', onData);
    inst.process.stdin!.write(header + body);
  });
}

function sendNotification(inst: LspServerInstance, method: string, params: unknown): void {
  const req = { jsonrpc: '2.0', method, params } as const;
  const body = JSON.stringify(req);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
  inst.process.stdin!.write(header + body);
}

// ==================== LSP 功能 ====================

export interface HoverResult {
  contents: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface CompletionResult {
  items: Array<{ label: string; kind?: number; detail?: string }>;
}

export interface DiagnosticResult {
  diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    message: string;
    source?: string;
  }>;
}

/** 打开文档 (textDocument/didOpen) */
export function lspDidOpen(inst: LspServerInstance, filePath: string, content: string): void {
  const uri = pathToUri(filePath);
  sendNotification(inst, 'textDocument/didOpen', {
    textDocument: { uri, languageId: inst.spec.language, version: 1, text: content },
  });
}

/** 悬停 (textDocument/hover) */
export async function lspHover(
  inst: LspServerInstance,
  filePath: string,
  line: number,
  character: number,
): Promise<HoverResult | null> {
  const uri = pathToUri(filePath);
  const result = await sendRequest(inst, 'textDocument/hover', {
    textDocument: { uri },
    position: { line, character },
  }) as any;
  if (!result || !result.contents) return null;
  const contents = Array.isArray(result.contents)
    ? result.contents.map((c: any) => typeof c === 'string' ? c : c.value || '').join('\n---\n')
    : typeof result.contents === 'object' ? (result.contents.value || JSON.stringify(result.contents))
    : String(result.contents);
  return { contents, range: result.range };
}

/** 补全 (textDocument/completion) */
export async function lspCompletion(
  inst: LspServerInstance,
  filePath: string,
  line: number,
  character: number,
): Promise<CompletionResult> {
  const uri = pathToUri(filePath);
  const result = await sendRequest(inst, 'textDocument/completion', {
    textDocument: { uri },
    position: { line, character },
  }) as any;
  const items = Array.isArray(result)
    ? result
    : (result?.items || []);
  return {
    items: items.map((item: any) => ({
      label: typeof item === 'string' ? item : (item.label || item.insertText || ''),
      kind: item.kind,
      detail: item.detail,
    })),
  };
}

/** 诊断 (textDocument/diagnostic — 需要拉模式) */
export async function lspDiagnostics(
  inst: LspServerInstance,
  filePath: string,
): Promise<DiagnosticResult> {
  const uri = pathToUri(filePath);
  // 先触发分析: didChange 或 didOpen
  try {
    const result = await sendRequest(inst, 'textDocument/diagnostic', {
      textDocument: { uri },
    }) as any;
    return { diagnostics: result?.diagnostics || result?.items || [] };
  } catch {
    return { diagnostics: [] };
  }
}

/** 转到定义 (textDocument/definition) */
export async function lspGoToDefinition(
  inst: LspServerInstance,
  filePath: string,
  line: number,
  character: number,
): Promise<{ uri: string; range: any } | null> {
  const uri = pathToUri(filePath);
  try {
    const result = await sendRequest(inst, 'textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    }) as any;
    if (!result) return null;
    // 可能返回 Location 或 Location[]
    const loc = Array.isArray(result) ? result[0] : result;
    if (!loc || !loc.uri) return null;
    return { uri: loc.uri, range: loc.range };
  } catch {
    return null;
  }
}

// ==================== 工具 ====================

function pathToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  return `file://${abs.startsWith('/') ? '' : '/'}${abs}`;
}

/** 根据文件扩展名找到合适的 LSP 服务器 */
export function findLspForFile(filePath: string, specs: LspServerSpec[]): LspServerSpec | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return specs.find(s => s.fileExtensions.includes(ext));
}
