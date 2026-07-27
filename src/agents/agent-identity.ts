/**
 * agent-identity.ts — 每个 channel 智能体的持久化 diap 身份
 *
 * 每个 agent (channel 智能体) 有独立的 Ed25519 keyPair + DID，
 * 类似 iroh-secret-*.json 的持久化机制，跨重启稳定。
 *
 * 文件: ~/.bolloon/agent-keys/<agentId>.json
 * 内容: { keyType, privateKey(hex), publicKey(hex), did, createdAt, lastUsedAt }
 *
 * 使用方式:
 *   const id = loadOrCreateAgentIdentity(channel.agentId);
 *   channel.did = id.did;
 *   channel.publicKey = id.publicKey;
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KeyManager } from '@diap/sdk';

const AGENT_KEYS_DIR = path.join(os.homedir(), '.bolloon', 'agent-keys');

export interface AgentIdentity {
  /** 32 字节 Ed25519 私钥 hex */
  privateKey: string;
  /** 32 字节 Ed25519 公钥 hex (对应 channel.publicKey) */
  publicKey: string;
  /** did:key:z... (对应 channel.did) */
  did: string;
  /** 首次创建时间 */
  createdAt: string;
  /** 是否为新创建的 (用于日志区分 "复用" / "新建") */
  reused: boolean;
}

/**
 * 加载或创建 agent 的持久化 diap 身份
 * - 文件存在 → 从私钥重建 keyPair
 * - 文件不存在 → 生成新 keyPair 并落盘
 */
export function loadOrCreateAgentIdentity(agentId: string): AgentIdentity {
  if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error(`[AgentIdentity] 无效 agentId: ${JSON.stringify(agentId)}`);
  }

  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fp = path.join(AGENT_KEYS_DIR, `${safeId}.json`);

  // === 文件已存在：复用 ===
  if (fs.existsSync(fp)) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      // 校验字段完整性
      if (j.privateKey && j.did && j.publicKey) {
        // 用 KeyManager.fromPrivateKey 重建确保一致性
        const pkBytes = Buffer.from(j.privateKey, 'hex');
        if (pkBytes.length === 32) {
          const kp = KeyManager.fromPrivateKey(pkBytes);
          return {
            privateKey: j.privateKey,
            publicKey: Buffer.from(kp.publicKey).toString('hex'),
            did: kp.did,
            createdAt: j.createdAt || 'unknown',
            reused: true,
          };
        }
      }
      // 文件损坏，回退到重新生成
      console.warn(`[AgentIdentity] ${agentId} 密钥文件损坏，重新生成`);
    } catch (e) {
      console.warn(`[AgentIdentity] ${agentId} 读取密钥文件失败，重新生成:`, (e as Error).message);
    }
  }

  // === 文件不存在或损坏：新建 ===
  const kp = KeyManager.generate();
  const privateKeyHex = Buffer.from(kp.privateKey).toString('hex');
  const publicKeyHex = Buffer.from(kp.publicKey).toString('hex');
  const createdAt = new Date().toISOString();

  // 确保目录存在
  fs.mkdirSync(AGENT_KEYS_DIR, { recursive: true });

  const data = {
    keyType: 'Ed25519',
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    did: kp.did,
    createdAt,
    lastUsedAt: createdAt,
    agentId,
    version: '1.0',
  };

  fs.writeFileSync(fp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(fp, 0o600); } catch { /* ignore */ }

  console.log(`[AgentIdentity] 新建 agent 密钥: ${agentId} → ${kp.did.substring(0, 24)}...`);

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    did: kp.did,
    createdAt,
    reused: false,
  };
}

/**
 * 更新 agent 密钥文件的 lastUsedAt 时间戳
 * (可选，用于审计追踪)
 */
export function touchAgentIdentity(agentId: string): void {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fp = path.join(AGENT_KEYS_DIR, `${safeId}.json`);
  if (!fs.existsSync(fp)) return;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    j.lastUsedAt = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(j, null, 2), { mode: 0o600 });
  } catch { /* silent */ }
}

/**
 * 列出所有已注册的 agent 身份
 */
export function listAgentIdentities(): Array<{ agentId: string; did: string; createdAt: string; lastUsedAt?: string }> {
  try {
    if (!fs.existsSync(AGENT_KEYS_DIR)) return [];
    const files = fs.readdirSync(AGENT_KEYS_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const safeId = f.replace(/\.json$/, '');
        const j = JSON.parse(fs.readFileSync(path.join(AGENT_KEYS_DIR, f), 'utf-8'));
        return {
          agentId: j.agentId || safeId,
          did: j.did || 'unknown',
          createdAt: j.createdAt || 'unknown',
          lastUsedAt: j.lastUsedAt,
        };
      } catch {
        return { agentId: f.replace(/\.json$/, ''), did: 'parse-error', createdAt: 'unknown' };
      }
    });
  } catch {
    return [];
  }
}

/**
 * 获取 agent 密钥文件的路径
 */
export function agentIdentityFilePath(agentId: string): string {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(AGENT_KEYS_DIR, `${safeId}.json`);
}