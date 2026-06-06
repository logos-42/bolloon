/**
 * p2p-secret.ts — 持久化 P2PDirect 的 32-byte secretKey
 *
 * 为什么: hyperswarm 4.x 的 `new Hyperswarm()` 每次启动生成新 keyPair,
 *  导致 publicKey 变化, known_peers.json 里的 publicKey 全部失效.
 *
 * 修法: 把 32-byte secretKey 存到 ~/.bolloon/p2p-direct-secret-{role}.json,
 *  下次启动读出来, 用 noise-keypair 风格构造 { publicKey, secretKey } 喂给 Hyperswarm.
 *  → 同一台机器 + 同一 role = 永远同一 publicKey.
 *
 * 文件格式: { version: 1, role, secretKey: hex64, publicKey: hex64, createdAt, lastUsedAt }
 *
 * role 来源: process.env.IROH_ROLE 或 process.env.BOLLOON_ROLE 或 'default'
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const SECRET_DIR = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');

export interface P2PSecret {
  version: 1;
  role: string;
  secretKey: string;     // 64 char hex (32 bytes) — noise-keypair seed
  publicKey: string;     // 64 char hex (32 bytes) — 由 hyperswarm 算出后写回
  createdAt: string;
  lastUsedAt: string;
}

function resolveRole(): string {
  return (
    process.env.IROH_ROLE ||
    process.env.BOLLOON_ROLE ||
    'default'
  );
}

function fileForRole(role: string): string {
  return path.join(SECRET_DIR, `p2p-direct-secret-${role}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SECRET_DIR, { recursive: true });
}

/**
 * 读取/生成 持久化的 keyPair.
 *
 * 首次启动 → 生成 32 字节随机 secretKey, 存盘 (publicKey 留空, 待 P2PDirect 写回)
 * 之后启动 → 读 secretKey, 信任文件里存的 publicKey
 *
 * @param roleOverride 可显式覆盖 role (不传时读 IROH_ROLE)
 * @returns { publicKey, secretKey, role } 全部 hex string
 */
export async function loadOrCreateKeyPair(roleOverride?: string): Promise<{
  publicKey: string;
  secretKey: string;
  role: string;
}> {
  const role = roleOverride || resolveRole();
  const file = fileForRole(role);

  try {
    const raw = await fs.readFile(file, 'utf-8');
    const existing: P2PSecret = JSON.parse(raw);
    if (
      existing.version === 1 &&
      typeof existing.secretKey === 'string' &&
      existing.secretKey.length === 64
    ) {
      const sk = Buffer.from(existing.secretKey, 'hex');
      if (sk.length === 32) {
        existing.lastUsedAt = new Date().toISOString();
        await ensureDir();
        await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf-8');
        return {
          publicKey: existing.publicKey || '',
          secretKey: existing.secretKey,
          role: existing.role,
        };
      }
    }
    console.warn(`[p2p-secret] ${file} 格式无效, 重新生成`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.warn(`[p2p-secret] 读 ${file} 失败: ${err.message}, 重新生成`);
    }
  }

  // 首次生成 — publicKey 留空, 等 P2PDirect.start() 拿到真公钥后写回
  const secretKeyBuf = crypto.randomBytes(32);
  const now = new Date().toISOString();
  const fresh: P2PSecret = {
    version: 1,
    role,
    secretKey: secretKeyBuf.toString('hex'),
    publicKey: '',         // P2PDirect.start() 后由 writebackPublicKey 填
    createdAt: now,
    lastUsedAt: now,
  };
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(fresh, null, 2), 'utf-8');
  console.log(`[p2p-secret] 新生成 keyPair (role=${role}, publicKey 待算), 存到 ${file}`);
  return { publicKey: fresh.publicKey, secretKey: fresh.secretKey, role };
}

/**
 * P2PDirect 启动后, 把 hyperswarm 算出的真实 publicKey 写回文件
 * (因为我们用 noise-keypair 风格 seed, 真正的公钥只能 Hyperswarm 算).
 */
export async function writebackPublicKey(
  role: string,
  secretKey: string,
  realPublicKey: string
): Promise<void> {
  const file = fileForRole(role);
  let existing: P2PSecret | null = null;
  try {
    const raw = await fs.readFile(file, 'utf-8');
    existing = JSON.parse(raw);
  } catch {}
  const data: P2PSecret = existing && existing.version === 1 && existing.secretKey === secretKey
    ? { ...existing, publicKey: realPublicKey, lastUsedAt: new Date().toISOString() }
    : {
        version: 1,
        role,
        secretKey,
        publicKey: realPublicKey,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[p2p-secret] (${role}) publicKey 写回: ${realPublicKey.substring(0, 12)}...`);
}

/** 删掉 (供调试 / "重置身份" 用) */
export async function resetSecret(roleOverride?: string): Promise<void> {
  const role = roleOverride || resolveRole();
  const file = fileForRole(role);
  try {
    await fs.unlink(file);
    console.log(`[p2p-secret] 删除 ${file}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** 当前 role 对应的 secret 文件路径 (供 server 暴露) */
export function secretPathForRole(roleOverride?: string): string {
  return fileForRole(roleOverride || resolveRole());
}
