/**
 * session-store — 持久化 Message[] (LLM 历史) 到 ~/.bolloon/sessions/cache/<key>.json
 *
 * 2026-06-30 抽出:
 *   - 之前 PiAgentSession 用 constraint-runtime 的 saveSession (存 string[]) + 独立的 hydrateMessageHistory
 *     读路径, 写路径不存在 — claude code / 外部 harness 想"接续 prompt"完全无入口.
 *   - 现在抽出 SessionStore 模块, 暴露纯 IO 接口, 完全可消融测试:
 *       saveMessages(key, msgs) — 写
 *       loadMessages(key)      — 读
 *       listKeys()              — 列全部 key
 *       deleteKey(key)          — 清
 *   - 任何目录位置都可注入 (默认 ~/.bolloon/sessions/cache/), 测试里指向临时 dir.
 *
 * 使用:
 *   import { sessionStore } from './session-store';
 *   sessionStore.saveMessages('cli:session-A', messageHistory);
 *   const restored = sessionStore.loadMessages('cli:session-A');
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** 工具调用 (assistant 角色下) */
  toolCall?: { id?: string; name: string; args: Record<string, string> };
  /** 工具结果 (tool 角色下) */
  toolCallId?: string;
  toolResult?: { success: boolean; output?: string; error?: string };
  /** 时间戳 — 用于调试 + 排序 */
  timestamp?: number;
  /** 来源标记 (cli/p2p/api/test) — 用于审计 */
  source?: string;
}

export interface PersistedSession {
  /** 文件名 = cacheKey.json */
  key: string;
  messages: PersistedMessage[];
  /** 元数据 */
  metadata: {
    savedAt: number;
    /** 原始 cwd — 防止跨机器回灌混淆 */
    cwd?: string;
    /** 总条数 — 防止超大文件加载 */
    totalCount: number;
  };
}

export interface SessionStoreConfig {
  /** 缓存目录. 默认 ~/.bolloon/sessions/cache/ */
  cacheDir?: string;
}

export class SessionStore {
  private readonly cacheDir: string;
  /** 2026-07-29: JSONL 目录 (~/.bolloon/sessions/jsonl/) */
  private readonly jsonlDir: string;

  constructor(config: SessionStoreConfig = {}) {
    this.cacheDir = config.cacheDir ?? path.join(os.homedir(), '.bolloon', 'sessions', 'cache');
    this.jsonlDir = path.join(os.homedir(), '.bolloon', 'sessions', 'jsonl');
  }

  get dir(): string {
    return this.cacheDir;
  }

  /** JSONL 文件路径 */
  jsonlPathFor(key: string): string {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    return path.join(this.jsonlDir, `${SessionStore.filenameEscape(key)}.jsonl`);
  }

  /**
   * 2026-07-29: Append-only JSONL — 追加一条消息.
   * 每条消息独立一行 JSON, 不破坏历史数据.
   * 每行格式: {ts, role, content, toolCall?, toolCallId?, toolResult?}
   */
  async appendMessageJsonl(key: string, msg: PersistedMessage): Promise<void> {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    await fs.mkdir(this.jsonlDir, { recursive: true });
    const filePath = this.jsonlPathFor(key);
    const line = JSON.stringify({
      ts: Date.now(),
      role: msg.role,
      content: msg.content,
      toolCall: msg.toolCall || undefined,
      toolCallId: msg.toolCallId || undefined,
      toolResult: msg.toolResult || undefined,
    }) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
  }

  /**
   * 2026-07-29: 从 JSONL 完整重建消息历史.
   * 文件不存在 → 返回 []. 损坏行 → 跳过不抛错.
   */
  async loadFromJsonl(key: string): Promise<PersistedMessage[]> {
    const filePath = this.jsonlPathFor(key);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }
    const messages: PersistedMessage[] = [];
    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (!entry.role) continue;
        messages.push({
          role: entry.role,
          content: entry.content || '',
          toolCall: entry.toolCall,
          toolCallId: entry.toolCallId,
          toolResult: entry.toolResult,
          timestamp: entry.ts,
        });
      } catch {
        // 跳过损坏行
      }
    }
    return messages;
  }

  /** 单文件路径 — 暴露出来方便测试和外部读取.
   *
   * 2026-07-04 fix: Windows 文件名禁止 `:` (NTFS). web server 用 `channelId:currentSessionId`
   * 拼 sessionKey (server.ts:1759 之类), 会含 `:`. 在 Linux/macOS 上能用, Windows 上
   * fs.writeFile 抛 EINVAL. 修法: filename 层 escape `:` → `__`, key 保持不变
   * (load/save/listKeys/deleteKey 全部透明).
   */
  pathFor(key: string): string {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    return path.join(this.cacheDir, `${SessionStore.filenameEscape(key)}.json`);
  }

  /** 把 session key 转换成跨平台安全的 filename (escape Windows 非法字符). */
  static filenameEscape(key: string): string {
    return key.replace(/:/g, '__');
  }
  /** listKeys 反向: 把 filename 还原成 session key. */
  static filenameUnescape(filenameKey: string): string {
    return filenameKey.replace(/__/g, ':');
  }

  /**
   * 写 history to disk.
   * - 自动 ensure 缓存目录
   * - 失败抛错 (写失败不应静默 — 用户可能依赖持久化作为审计)
   */
  async saveMessages(key: string, messages: PersistedMessage[]): Promise<void> {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    await fs.mkdir(this.cacheDir, { recursive: true });
    const payload: PersistedSession = {
      key,
      messages,
      metadata: {
        savedAt: Date.now(),
        cwd: process.cwd(),
        totalCount: messages.length,
      },
    };
    const filePath = this.pathFor(key);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
    // 2026-07-29: 同时写 JSONL (增量追加, 不覆盖)
    //   每个 message 一个 append, 保证可审计 + 可重建
    try {
      await fs.mkdir(this.jsonlDir, { recursive: true });
      const jsonlPath = this.jsonlPathFor(key);
      const lines: string[] = [];
      for (const msg of messages) {
        lines.push(JSON.stringify({
          ts: msg.timestamp || Date.now(),
          role: msg.role,
          content: msg.content,
          toolCall: msg.toolCall || undefined,
          toolCallId: msg.toolCallId || undefined,
          toolResult: msg.toolResult || undefined,
        }));
      }
      await fs.appendFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');
    } catch { /* JSONL 写入失败不阻塞主存储 */ }
  }

  /**
   * 同步版 (PiAgentSession 里多条路径用同步 — 避免 async 链)
   * 失败抛错
   */
  saveMessagesSync(key: string, messages: PersistedMessage[]): void {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    fsSyncMkdir(this.cacheDir);
    const payload: PersistedSession = {
      key,
      messages,
      metadata: {
        savedAt: Date.now(),
        cwd: process.cwd(),
        totalCount: messages.length,
      },
    };
    const filePath = this.pathFor(key);
    const tmpPath = `${filePath}.tmp`;
    fsSyncWrite(tmpPath, JSON.stringify(payload, null, 2));
    fsSyncRename(tmpPath, filePath);
  }

  /**
   * 读 history from disk.
   * - key 不存在 → 返回 null (不抛错)
   * - 文件存在但 JSON 损坏 → 抛错 (claude code 应该感知坏数据)
   * - 文件 schema 不匹配 (新版格式) → 抛错含 details
   */
  async loadMessages(key: string): Promise<PersistedMessage[] | null> {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    const filePath = this.pathFor(key);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) {
      throw new Error(`SessionStore: ${key} schema invalid (missing messages[])`);
    }
    return parsed.messages as PersistedMessage[];
  }

  /** 列所有 keys — 用于调试 / claude code "看有哪些 session 可接续". */
  async listKeys(): Promise<string[]> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const files = await fs.readdir(this.cacheDir);
      return files
        .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
        .map(f => SessionStore.filenameUnescape(f.slice(0, -'.json'.length)))
        .sort();
    } catch {
      return [];
    }
  }

  /** 删一条 session — 失败抛错. */
  async deleteKey(key: string): Promise<void> {
    if (!key || key.includes('/') || key.includes('..')) {
      throw new Error(`SessionStore: invalid key ${JSON.stringify(key)}`);
    }
    try {
      await fs.unlink(this.pathFor(key));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}

// --- sync fs helpers (避免 import 'fs' 二次) ---
function fsSyncMkdir(dir: string): void {
  try {
    require('fs').mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
  }
}
function fsSyncWrite(filePath: string, content: string): void {
  require('fs').writeFileSync(filePath, content, 'utf-8');
}
function fsSyncRename(from: string, to: string): void {
  require('fs').renameSync(from, to);
}

/** 默认 store 实例 (用 ~/.bolloon/sessions/cache/). 业务代码用这个. */
export const sessionStore = new SessionStore();
