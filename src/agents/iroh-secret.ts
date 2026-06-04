/**
 * iroh-secret - 把 iroh secretKey 落 ~/.bolloon/iroh-secret.json
 *
 * iroh 默认每次启动生成新节点 ID；落盘后可实现"跨重启稳定 nodeId"。
 * 对应 Issue: "建联一次访问所有智能体"需要稳定标识, 不然对方缓存的 nodeId 失效
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const SECRET_DIR = path.join(os.homedir(), '.bolloon');

export function loadOrCreateIrohSecret(role: string = 'default'): { secretKey: Uint8Array; createdAt: string; reused: boolean } {
  if (!fs.existsSync(SECRET_DIR)) fs.mkdirSync(SECRET_DIR, { recursive: true });
  const fp = path.join(SECRET_DIR, `iroh-secret-${role}.json`);
  if (fs.existsSync(fp)) {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return { secretKey: Buffer.from(j.secretKey, 'hex'), createdAt: j.createdAt, reused: true };
  }
  const sk = crypto.randomBytes(32);
  const createdAt = new Date().toISOString();
  fs.writeFileSync(fp, JSON.stringify({ secretKey: sk.toString('hex'), createdAt }, null, 2));
  return { secretKey: sk, createdAt, reused: false };
}

export function irohSecretFilePath(role: string = 'default'): string {
  return path.join(SECRET_DIR, `iroh-secret-${role}.json`);
}
