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

/** 添加或更新一个 known peer (key 用 name, 但按 publicKey 去重) */
export async function addOrUpdatePeer(name: string | null | undefined, publicKey: string, notes?: string): Promise<void> {
  const safeName = (name && name.length > 0) ? name : `peer-${publicKey.substring(0, 8)}`;
  const data = await readFile();

  // 2026-08-02 fix: 按 publicKey 去重 — 之前用 name 作 key, 同一 publicKey 被
  //   自动发现 (discovered-xxx) / 手动添加 (备注名) / manifest 重命名 (ownerName)
  //   等多条路径写入时, 会生成多条重复条目 (apple/mechrevo/node 指向同一节点)。
  //   现在: 若 publicKey 已存在 (无论 name 是什么), 复用那条 entry 只更新名字/备注。
  let existingEntry: KnownPeer | undefined;
  let existingName: string | null = null;
  for (const [n, p] of Object.entries(data.peers)) {
    if (p.publicKey === publicKey) {
      existingEntry = p;
      existingName = n;
      break;
    }
  }

  const targetName = existingName || safeName;
  if (existingEntry) {
    // 同 publicKey 已存在 → 更新 (保留原 addedAt, 新名字非 discovered- 前缀时替换)
    // 2026-08-02 二次修: 用户手动命名过的条目 (非 discovered- 前缀, 如 mechrevo)
    //   不应被自动来源的名字 (senderName/node/ownerName) 覆盖 — 只有自动名
    //   (discovered-xxx / peer-xxx) 才允许被替换成更有意义的名称。
    const userNamed = existingName && !existingName.startsWith('discovered-') && !existingName.startsWith('peer-');
    const keepAutoName = existingName?.startsWith('discovered-') && !name;
    let finalName: string;
    if (userNamed) {
      finalName = existingName!;  // 保留用户命名
    } else if (keepAutoName) {
      finalName = existingName!;
    } else {
      finalName = safeName;
    }
    if (finalName !== existingName) {
      delete data.peers[existingName!];
    }
    data.peers[finalName] = {
      publicKey,
      name: finalName,
      addedAt: existingEntry.addedAt || new Date().toISOString(),
      lastConnectedAt: existingEntry.lastConnectedAt,
      notes: notes || existingEntry.notes
    };
    await writeFile(data);
    console.log(`[known-peers] 更新 (publicKey 去重): ${finalName} = ${publicKey.substring(0, 12)}...`);
    return;
  }

  data.peers[targetName] = {
    publicKey,
    name: targetName,
    addedAt: new Date().toISOString(),
    lastConnectedAt: undefined,
    notes: notes || undefined
  };
  await writeFile(data);
  console.log(`[known-peers] 添加/更新: ${targetName} = ${publicKey.substring(0, 12)}...`);
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
