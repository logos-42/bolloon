/**
 * peer-fs.ts — peer 目录读写 + agents 索引 + manifest 落盘
 *
 * 设计目的 (2026-07-05):
 *   把"远程 P2P 节点"在本地物化成一份文件夹, 让本地所有 agent 都能"知道对方有什么":
 *   ~/.bolloon/peers/<publicKey>/
 *     peer.json               ← 对方基础信息 (name / publicKey / lastSeen / lastManifestTs)
 *     user.md                 ← 对方用户画像 (本地维护)
 *     _index.json             ← 对方 agent 列表 (轻量, 懒加载时优先读)
 *     capability-index.md     ← ≤500 字摘要, 拼进 prompt
 *     agents/<agentId>.md     ← 每个 agent 详细描述
 *     groups/<groupId>.md     ← 群组
 *     function/<cap>.md       ← 视频/音乐/图片
 *     exportment/<game>.md    ← 游戏
 *     science/<exp>.md        ← 实验记录
 *     chat-<YYYY-MM>.md       ← 月度聊天记录归档
 *     outbox.jsonl            ← 离线发送队列 (对方不在线时缓存)
 *
 * 写盘策略:
 *   - 纯文本 md 文件, 人类可读, 便于调试
 *   - JSON 仅用于 peer.json / _index.json / outbox.jsonl
 *   - 全部操作 atomic (write tmp + rename), 避免半截文件
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ============== 路径常量 ==============

const HOME = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
const PEERS_ROOT = path.join(HOME, 'peers');

/** publicKey hex → 短哈希, 用于目录名防超长 */
export function peerDirName(publicKey: string): string {
  // 用 sha256 前 16 位 hex, 防 publicKey 改名冲突 + 文件名长度可控
  const h = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  return `${h}__${publicKey.slice(0, 8)}`;
}

export function getPeerDir(publicKey: string): string {
  return path.join(PEERS_ROOT, peerDirName(publicKey));
}

export function getPeerIndexPath(publicKey: string): string {
  return path.join(getPeerDir(publicKey), '_index.json');
}

export function getPeerJsonPath(publicKey: string): string {
  return path.join(getPeerDir(publicKey), 'peer.json');
}

export function getPeerCapabilityIndexPath(publicKey: string): string {
  return path.join(getPeerDir(publicKey), 'capability-index.md');
}

export function getPeerChatPath(publicKey: string, yearMonth?: string): string {
  const ym = yearMonth || currentYearMonth();
  return path.join(getPeerDir(publicKey), `chat-${ym}.md`);
}

export function getPeerOutboxPath(publicKey: string): string {
  return path.join(getPeerDir(publicKey), 'outbox.jsonl');
}

export function getPeerUserMdPath(publicKey: string): string {
  return path.join(getPeerDir(publicKey), 'user.md');
}

export function getPeerAgentMdPath(publicKey: string, agentId: string): string {
  return path.join(getPeerDir(publicKey), 'agents', `${safeName(agentId)}.md`);
}

export function getPeerGroupMdPath(publicKey: string, groupId: string): string {
  return path.join(getPeerDir(publicKey), 'groups', `${safeName(groupId)}.md`);
}

export function getPeerFunctionMdPath(publicKey: string, capability: string): string {
  return path.join(getPeerDir(publicKey), 'function', `${safeName(capability)}.md`);
}

export function getPeerExportmentMdPath(publicKey: string, game: string): string {
  return path.join(getPeerDir(publicKey), 'exportment', `${safeName(game)}.md`);
}

export function getPeerScienceMdPath(publicKey: string, expId: string): string {
  return path.join(getPeerDir(publicKey), 'science', `${safeName(expId)}.md`);
}

export function currentYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 文件名安全化: 去掉 / \ : * ? " < > | 控制符 */
function safeName(s: string): string {
  return s.replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, '_').slice(0, 64);
}

// ============== 类型 ==============

export interface PeerRecord {
  publicKey: string;
  name?: string;
  addedAt: string;
  lastSeenAt?: string;
  lastManifestTs?: number;       // 最新 manifest 的 publishedAt
  manifestCount?: number;        // 已接收 manifest 总数
  notes?: string;
}

export interface PeerAgentEntry {
  id: string;
  name: string;
  capabilities: string[];
  status: string;
  description?: string;
  peerId?: string;
  irohNodeId?: string;
  sessionId?: string;
  cid?: string;
  ipnsName?: string;
}

export interface PeerIndexFile {
  version: 1;
  publicKey: string;
  ownerName?: string;
  ownerDescription?: string;
  agents: PeerAgentEntry[];
  groups?: Array<{ id: string; name: string; description?: string }>;
  functions?: Array<{ capability: string; description?: string }>;
  exportments?: Array<{ name: string; description?: string }>;
  updatedAt: string;
  manifestTs?: number;
}

export interface ChatArchiveEntry {
  ts: string;                    // ISO 8601
  source: 'local' | 'remote' | 'ai-mention' | 'ai-mention-remote';
  channelId?: string;
  channelName?: string;
  text: string;
  fromPublicKey?: string;
  fromAgentId?: string;
}

export interface OutboxEntry {
  id: string;
  ts: string;
  op: string;                    // RPC op 名
  payload: any;                  // RPC payload
  attempts: number;
  lastError?: string;
}

// ============== Atomic write helper ==============

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + Math.random().toString(36).slice(2, 8);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

async function atomicWriteJson(filePath: string, obj: any): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ============== peer.json ==============

export async function upsertPeer(rec: Partial<PeerRecord> & { publicKey: string }): Promise<PeerRecord> {
  const file = getPeerJsonPath(rec.publicKey);
  const existing = await readJsonSafe<PeerRecord>(file);
  const merged: PeerRecord = {
    publicKey: rec.publicKey,
    name: rec.name ?? existing?.name,
    addedAt: existing?.addedAt || rec.addedAt || new Date().toISOString(),
    lastSeenAt: rec.lastSeenAt ?? existing?.lastSeenAt,
    lastManifestTs: rec.lastManifestTs ?? existing?.lastManifestTs,
    manifestCount: rec.manifestCount ?? existing?.manifestCount,
    notes: rec.notes ?? existing?.notes,
  };
  await atomicWriteJson(file, merged);
  return merged;
}

export async function getPeer(publicKey: string): Promise<PeerRecord | null> {
  return readJsonSafe<PeerRecord>(getPeerJsonPath(publicKey));
}

export async function listPeersFromDisk(): Promise<PeerRecord[]> {
  try {
    const entries = await fs.readdir(PEERS_ROOT);
    const out: PeerRecord[] = [];
    for (const e of entries) {
      const peerFile = path.join(PEERS_ROOT, e, 'peer.json');
      const rec = await readJsonSafe<PeerRecord>(peerFile);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

// ============== _index.json (agent 清单) ==============

export async function writePeerIndex(publicKey: string, idx: PeerIndexFile): Promise<void> {
  await atomicWriteJson(getPeerIndexPath(publicKey), idx);
}

export async function readPeerIndex(publicKey: string): Promise<PeerIndexFile | null> {
  return readJsonSafe<PeerIndexFile>(getPeerIndexPath(publicKey));
}

// ============== 单个 agent 详细描述 (markdown) ==============

export async function writeAgentDescription(
  publicKey: string,
  agent: PeerAgentEntry,
  ownerDescription?: string
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${agent.name || agent.id}`);
  lines.push('');
  lines.push(`- **ID**: ${agent.id}`);
  lines.push(`- **状态**: ${agent.status}`);
  if (agent.capabilities.length) {
    lines.push(`- **能力**: ${agent.capabilities.join(', ')}`);
  }
  if (agent.description) {
    lines.push('');
    lines.push('## 描述');
    lines.push('');
    lines.push(agent.description);
  }
  if (ownerDescription) {
    lines.push('');
    lines.push('## Owner 备注');
    lines.push('');
    lines.push(ownerDescription);
  }
  if (agent.peerId || agent.irohNodeId || agent.sessionId) {
    lines.push('');
    lines.push('## 寻址');
    if (agent.peerId) lines.push(`- peerId: ${agent.peerId}`);
    if (agent.irohNodeId) lines.push(`- irohNodeId: ${agent.irohNodeId}`);
    if (agent.sessionId) lines.push(`- sessionId: ${agent.sessionId}`);
  }
  lines.push('');
  lines.push(`> 自动生成于 ${new Date().toISOString()} (peer=${publicKey.slice(0, 12)}...)`);
  lines.push('');
  await atomicWrite(getPeerAgentMdPath(publicKey, agent.id), lines.join('\n'));
}

// ============== capability-index.md (≤500 字摘要, 进 prompt) ==============

export function buildCapabilityIndex(idx: PeerIndexFile): string {
  const lines: string[] = [];
  lines.push(`# 远端节点能力索引 — ${idx.ownerName || idx.publicKey.slice(0, 12)}`);
  lines.push('');
  if (idx.ownerDescription) {
    lines.push(idx.ownerDescription.slice(0, 200));
    lines.push('');
  }
  lines.push(`## Agent (${idx.agents.length} 个)`);
  for (const a of idx.agents.slice(0, 20)) {
    const caps = a.capabilities.length ? ` [${a.capabilities.join('/')}]` : '';
    const desc = a.description ? ` — ${a.description.slice(0, 60)}` : '';
    lines.push(`- ${a.name}${caps}${desc}`);
  }
  if (idx.agents.length > 20) lines.push(`- … 还有 ${idx.agents.length - 20} 个`);
  if (idx.groups?.length) {
    lines.push('');
    lines.push(`## 群组 (${idx.groups.length})`);
    for (const g of idx.groups.slice(0, 10)) lines.push(`- ${g.name}${g.description ? ' — ' + g.description.slice(0, 50) : ''}`);
  }
  if (idx.functions?.length) {
    lines.push('');
    lines.push(`## 可用功能 (${idx.functions.length})`);
    for (const f of idx.functions.slice(0, 10)) lines.push(`- ${f.capability}${f.description ? ' — ' + f.description.slice(0, 50) : ''}`);
  }
  if (idx.exportments?.length) {
    lines.push('');
    lines.push(`## 娱乐 (${idx.exportments.length})`);
    for (const e of idx.exportments.slice(0, 10)) lines.push(`- ${e.name}${e.description ? ' — ' + e.description.slice(0, 50) : ''}`);
  }
  const text = lines.join('\n');
  // 截到 500 字
  return text.length > 500 ? text.slice(0, 497) + '…' : text;
}

export async function writeCapabilityIndex(publicKey: string, idx: PeerIndexFile): Promise<void> {
  const text = buildCapabilityIndex(idx);
  await atomicWrite(getPeerCapabilityIndexPath(publicKey), text);
}

export async function readCapabilityIndex(publicKey: string): Promise<string | null> {
  try { return await fs.readFile(getPeerCapabilityIndexPath(publicKey), 'utf-8'); } catch { return null; }
}

// ============== chat-<YYYY-MM>.md 月度归档 ==============

function formatChatEntry(e: ChatArchiveEntry): string {
  const ts = e.ts.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const src = e.source;
  const chan = e.channelName ? ` [${e.channelName}]` : '';
  const from = e.fromPublicKey ? ` (${e.fromPublicKey.slice(0, 12)}…)` : '';
  return `### ${ts}${chan} — ${src}${from}\n\n${e.text}\n`;
}

export async function appendChat(publicKey: string, entry: ChatArchiveEntry): Promise<void> {
  const file = getPeerChatPath(publicKey);
  // 如果文件不存在, 先写头
  try {
    await fs.access(file);
  } catch {
    await atomicWrite(file, `# 与 ${publicKey.slice(0, 12)}… 的聊天记录\n\n> 自动归档; 详细消息存于 sessions/cache/, 这里按月滚动.\n\n`);
  }
  // append
  await fs.appendFile(file, '\n---\n\n' + formatChatEntry(entry), 'utf-8');
}

export async function readChatArchive(publicKey: string, yearMonth?: string): Promise<string | null> {
  try { return await fs.readFile(getPeerChatPath(publicKey, yearMonth), 'utf-8'); } catch { return null; }
}

export async function listChatMonths(publicKey: string): Promise<string[]> {
  try {
    const dir = getPeerDir(publicKey);
    const entries = await fs.readdir(dir);
    return entries
      .filter(e => /^chat-\d{4}-\d{2}\.md$/.test(e))
      .map(e => e.replace(/^chat-/, '').replace(/\.md$/, ''))
      .sort();
  } catch { return []; }
}

// ============== outbox.jsonl 离线队列 ==============

export async function enqueueOutbox(publicKey: string, entry: OutboxEntry): Promise<void> {
  const file = getPeerOutboxPath(publicKey);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function readOutbox(publicKey: string): Promise<OutboxEntry[]> {
  try {
    const raw = await fs.readFile(getPeerOutboxPath(publicKey), 'utf-8');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

export async function clearOutbox(publicKey: string): Promise<void> {
  try { await fs.unlink(getPeerOutboxPath(publicKey)); } catch {}
}

export async function countOutbox(publicKey: string): Promise<number> {
  return (await readOutbox(publicKey)).length;
}

// ============== user.md 本地维护的对方用户画像 ==============

export async function readUserPortrait(publicKey: string): Promise<string | null> {
  try { return await fs.readFile(getPeerUserMdPath(publicKey), 'utf-8'); } catch { return null; }
}

export async function writeUserPortrait(publicKey: string, markdown: string): Promise<void> {
  await atomicWrite(getPeerUserMdPath(publicKey), markdown);
}

// ============== 通用: 读所有类别目录 (groups/function/exportment/science) ==============

export interface ResourceListing {
  groups: Array<{ id: string; content: string }>;
  functions: Array<{ capability: string; content: string }>;
  exportments: Array<{ name: string; content: string }>;
  sciences: Array<{ id: string; content: string }>;
}

export async function listPeerResources(publicKey: string): Promise<ResourceListing> {
  const dir = getPeerDir(publicKey);
  const out: ResourceListing = { groups: [], functions: [], exportments: [], sciences: [] };
  for (const [subdir, key] of [
    ['groups', 'groups'],
    ['function', 'functions'],
    ['exportment', 'exportments'],
    ['science', 'sciences'],
  ] as const) {
    try {
      const entries = await fs.readdir(path.join(dir, subdir));
      for (const e of entries) {
        if (!e.endsWith('.md')) continue;
        const content = await fs.readFile(path.join(dir, subdir, e), 'utf-8');
        const id = e.replace(/\.md$/, '');
        if (key === 'groups') out.groups.push({ id, content });
        else if (key === 'functions') out.functions.push({ capability: id, content });
        else if (key === 'exportments') out.exportments.push({ name: id, content });
        else out.sciences.push({ id, content });
      }
    } catch {}
  }
  return out;
}

// ============== 测试 / 调试 helper ==============

export const _debug = {
  PEERS_ROOT,
  peerDirName,
  getPeerDir,
};