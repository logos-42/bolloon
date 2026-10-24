/**
 * local-signer.ts — 本机 DID 身份签名器 (P3, 2026-09-21)
 *
 * `bolloon-task/1` 的每一个信封 (request / accept / reject / result) 都必须带签名。
 * 签名用的是本机 DIAP 身份 (`~/.bolloon/identity.json`, ed25519) —— **私钥只在本机进程内存里**,
 * 本模块**只返回可用于签名的 keypair 对象**, 绝不返回私钥字符串/hex, 也不打印任何密钥材料。
 *
 * 红线 (P1 §5.5):
 *   · 私钥永不进 stdout/日志/审计账本;
 *   · 公钥 (hex) 可以随帧一起走 P2P —— 对端需要它来验签, 它是公开材料;
 *   · 没有本机身份 → 返回 null, 调用方必须**如实失败**, 不许用假签名糊过去。
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { bolloonHome } from '../bootstrap/env-loader.js';

export interface LocalSigner {
  /** did:key:z... (公开) */
  did: string;
  /** 32 字节 ed25519 公钥 hex (公开; 对端验签用) */
  publicKeyHex: string;
  /** @diap/sdk KeyPair —— **只在签名的一瞬间用**, 绝不外泄/打印/落盘 */
  keypair: unknown;
}

/** 本机身份文件 (与 network-pulse 快照签名同源: ~/.bolloon/identity.json) */
export function identityFile(home?: string): string {
  return path.join(bolloonHome(), 'identity.json');
}

/**
 * 加载本机签名器。文件缺失/损坏 → null (调用方如实报"没有可签名的身份")。
 */
export async function loadLocalSigner(home?: string): Promise<LocalSigner | null> {
  try {
    const file = identityFile(home);
    const { KeyManager } = (await import('@diap/sdk')) as any;
    const kp: any = await (KeyManager as any).fromFile(file);
    if (!kp?.privateKey || !kp?.publicKey) return null;
    return { did: String(kp.did || ''), publicKeyHex: Buffer.from(kp.publicKey as Uint8Array).toString('hex'), keypair: kp };
  } catch {
    return null;
  }
}

/** 本机公钥 hex (给帧的信封用; 没有身份 → null) */
export async function localPublicKeyHex(home?: string): Promise<string | null> {
  const s = await loadLocalSigner(home);
  return s?.publicKeyHex ?? null;
}

/**
 * 从公钥 hex 造一个 `KeyManager.verify` 能吃的 verifier。
 * (@diap/sdk 的 verify 只用到 `publicKey` 字段 —— 它改不了密钥的用途, 这里不涉及任何私钥。)
 */
export function verifierFor(publicKeyHex: string): { publicKey: Uint8Array } | null {
  if (!/^[0-9a-f]{64}$/i.test(String(publicKeyHex || ''))) return null;
  return { publicKey: new Uint8Array(Buffer.from(publicKeyHex, 'hex')) };
}

/**
 * 指纹 (sha256 前 12 位 hex) —— 只用于日志/审计的"是谁签的", **不可逆, 不含密钥材料**。
 */
export function fingerprintOf(input: string): string {
  return `sha256:${crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, 12)}`;
}

/** payload 摘要 (审计账本只记摘要, 不记正文) */
export function payloadDigest(payload: string): string {
  return crypto.createHash('sha256').update(String(payload ?? '')).digest('hex');
}
