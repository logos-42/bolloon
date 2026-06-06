/**
 * known-peers.ts — 持久化 P2P 好友列表, 启动自动重连
 *
 * 文件位置: ~/.bolloon/known_peers.json
 * 格式: { version: 1, peers: { [name]: { publicKey, addedAt, lastConnected } } }
 *
 * 设计原则:
 *   - publicKey 持久化 (peerId 等同于 P2PDirect publicKey = 32 字节 hex = 64 chars)
 *   - name 是用户给的好友备注 (不参与 P2P 协议, 仅 UI 显示)
 *   - 不存 ip/port, hyperswarm DHT 自动重发现
 *   - 不存 lastConnected 详细信息, 只存时间戳 (供 UI 显示)
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const SECRET_DIR = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
const KNOWN_PEERS_FILE = path.join(SECRET_DIR, 'known_peers.json');

export interface KnownPeer {
  publicKey: string;          // 64 char hex
  name?: string;              // 用户给的备注
  addedAt: string;            // ISO timestamp
  lastConnectedAt?: string;   // ISO timestamp, 最近一次 joinPeer 成功
  notes?: string;             // 用户备注
}

interface KnownPeersFile {
  version: 1;
  peers: Record<string, KnownPeer>;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SECRET_DIR, { recursive: true });
}

async function readFile(): Promise<KnownPeersFile> {
  try {
    const raw = await fs.readFile(KNOWN_PEERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, peers: {} };
  }
}

async function writeFile(data: KnownPeersFile): Promise<void> {
  await ensureDir();
  await fs.writeFile(KNOWN_PEERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** 添加或更新一个 known peer (key 用 name) */
export async function addOrUpdatePeer(name: string, publicKey: string, notes?: string): Promise<void> {
  const data = await readFile();
  const existing = data.peers[name];
  data.peers[name] = {
    publicKey,
    name,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastConnectedAt: existing?.lastConnectedAt,
    notes: notes || existing?.notes
  };
  await writeFile(data);
  console.log(`[known-peers] 添加/更新: ${name} = ${publicKey.substring(0, 12)}...`);
}

/** 删除 known peer */
export async function removePeer(name: string): Promise<void> {
  const data = await readFile();
  if (data.peers[name]) {
    delete data.peers[name];
    await writeFile(data);
    console.log(`[known-peers] 删除: ${name}`);
  }
}

/** 标记连接成功 (更新 lastConnectedAt) */
export async function markConnected(name: string): Promise<void> {
  const data = await readFile();
  if (data.peers[name]) {
    data.peers[name].lastConnectedAt = new Date().toISOString();
    await writeFile(data);
  }
}

/** 列出所有 known peers */
export async function listPeers(): Promise<KnownPeer[]> {
  const data = await readFile();
  return Object.values(data.peers);
}

/** 通过 publicKey 找 name (用于自动标记 lastConnectedAt) */
export async function findNameByPublicKey(publicKey: string): Promise<string | null> {
  const data = await readFile();
  for (const [name, p] of Object.entries(data.peers)) {
    if (p.publicKey === publicKey) return name;
  }
  return null;
}

/** 完整文件路径 (供 web server 暴露) */
export const KNOWN_PEERS_PATH = KNOWN_PEERS_FILE;
