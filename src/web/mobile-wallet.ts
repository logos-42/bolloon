/**
 * mobile-wallet.ts — 手机端加密钱包 v2 (多钱包, EVM, 只读 MVP)
 *
 * 用户需求 (2026-09-05):
 *  - 多个加密钱包, 可创建新钱包
 *  - 本地自动加载 (无口令) — auto 模式: 用设备本地密钥 (deviceSecret) 加密, 打开即解锁
 *  - 或 口令解锁 — passphrase 模式: 用户口令 (PBKDF2) 加密, 需输入口令 (生物识别为 native 后置)
 *  - 每个钱包可授权给多个本地智能体 (allowedAgents), 仅本地创建的智能体能调自己的钱包
 *
 * 被 mobile-core.ts import → esbuild bundle 进 mobile-core.js (离线可用).
 */
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// ============ IndexedDB (自持 kv) ============
const DB_NAME = 'bolloon';
const STORE = 'kv';
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    t.onsuccess = () => res(t.result as T | undefined);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

// ============ 类型 ============
export type WalletMode = 'auto' | 'passphrase';
interface WalletRecord {
  id: string;
  name: string;
  address: string;
  enc: { iv: string; data: string; salt?: string };  // salt 仅 passphrase 用
  mode: WalletMode;
  allowedAgents: string[];   // 可调用的本地 agentId (仅本地创建)
  createdAt: number;
  chain: string;
}
export interface WalletSummary {
  id: string; name: string; address: string; mode: WalletMode;
  unlocked: boolean; allowedAgents: string[]; createdAt: number;
}
export interface WalletStatus {
  exists: boolean; wallets: WalletSummary[];
}

const WKEY = 'wallets';          // WalletRecord[]
const DSKEY = 'device_secret';   // 设备本地密钥 (auto 模式用, hex)
const DEFAULT_RPC = 'https://eth.llamarpc.com';

// 内存解锁态: id → privKey (仅当前会话)
const unlockedKeys = new Map<string, Uint8Array>();

// ============ hex/b64 工具 ============
function bytesToHex(b: Uint8Array): string { return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error('hex 长度需为偶数');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToB64(b: Uint8Array): string { let s = ''; b.forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); }
function b64ToBytes(s: string): Uint8Array { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

// ============ 派生 ============
function derivePrivateKey(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic, '');
  const hd = HDKey.fromMasterSeed(seed);
  const pk = hd.derive("m/44'/60'/0'/0/0").privateKey;
  if (!pk || pk.length !== 32) throw new Error('派生私钥失败');
  return pk;
}
function privToAddress(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  const hash = keccak_256(pub.subarray(1));
  return '0x' + bytesToHex(hash.subarray(12));
}

// ============ WebCrypto ============
async function pbkdf2Key(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function rawKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptWith(key: CryptoKey, plain: Uint8Array): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource);
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}
async function decryptWith(key: CryptoKey, enc: { iv: string; data: string }): Promise<Uint8Array> {
  const iv = b64ToBytes(enc.iv); const ct = b64ToBytes(enc.data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return new Uint8Array(pt);
}

// ============ 设备密钥 与 钱包列表 ============
async function deviceSecretBytes(): Promise<Uint8Array> {
  let hex = await idbGet<string>(DSKEY);
  if (!hex) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hex = bytesToHex(bytes);
    await idbSet(DSKEY, hex);
  }
  return hexToBytes(hex);
}
async function loadWallets(): Promise<WalletRecord[]> { return (await idbGet<WalletRecord[]>(WKEY)) || []; }
async function saveWallets(list: WalletRecord[]): Promise<void> { await idbSet(WKEY, list); }

// ============ 公开 API ============
export async function listWallets(): Promise<WalletStatus> {
  const list = await loadWallets();
  const wallets: WalletSummary[] = list.map((w) => ({
    id: w.id, name: w.name, address: w.address, mode: w.mode,
    unlocked: unlockedKeys.has(w.id), allowedAgents: w.allowedAgents || [], createdAt: w.createdAt,
  }));
  return { exists: list.length > 0, wallets };
}

export async function createWallet(name: string, mode: WalletMode, pass?: string): Promise<{ id: string; address: string; mnemonic: string; name: string }> {
  const mnemonic = generateMnemonic(english);
  const priv = derivePrivateKey(mnemonic);
  const address = privToAddress(priv);
  let enc: WalletRecord['enc'];
  if (mode === 'auto') {
    const key = await rawKey(await deviceSecretBytes());
    enc = await encryptWith(key, priv);
  } else {
    if (!pass) throw new Error('口令模式需要口令');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await pbkdf2Key(pass, salt);
    const r = await encryptWith(key, priv);
    enc = { iv: r.iv, data: r.data, salt: bytesToB64(salt) };
  }
  const id = 'wallet-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const rec: WalletRecord = { id, name: name || ('钱包 ' + ((await loadWallets()).length + 1)), address, enc, mode, allowedAgents: [], createdAt: Date.now(), chain: '1' };
  const list = await loadWallets();
  list.push(rec);
  await saveWallets(list);
  if (mode === 'auto') unlockedKeys.set(id, priv);
  return { id, address, mnemonic, name: rec.name };
}

export async function importWallet(input: string, name: string, mode: WalletMode, pass?: string): Promise<{ id: string; address: string; name: string }> {
  const s = (input || '').trim();
  let priv: Uint8Array;
  if (validateMnemonic(s, english)) priv = derivePrivateKey(s);
  else {
    priv = hexToBytes(s);
    if (priv.length !== 32) throw new Error('私钥需为 32 字节 (64 位 hex) 或有效助记词');
  }
  const address = privToAddress(priv);
  let enc: WalletRecord['enc'];
  if (mode === 'auto') enc = await encryptWith(await rawKey(await deviceSecretBytes()), priv);
  else {
    if (!pass) throw new Error('口令模式需要口令');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await pbkdf2Key(pass, salt);
    const r = await encryptWith(key, priv);
    enc = { iv: r.iv, data: r.data, salt: bytesToB64(salt) };
  }
  const id = 'wallet-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const list = await loadWallets();
  const rec: WalletRecord = { id, name: name || ('钱包 ' + (list.length + 1)), address, enc, mode, allowedAgents: [], createdAt: Date.now(), chain: '1' };
  list.push(rec);
  await saveWallets(list);
  if (mode === 'auto') unlockedKeys.set(id, priv);
  return { id, address, name: rec.name };
}

export async function unlockWallet(id: string, pass: string): Promise<{ address: string }> {
  const list = await loadWallets();
  const w = list.find((x) => x.id === id);
  if (!w) throw new Error('钱包不存在');
  const salt = w.enc.salt ? b64ToBytes(w.enc.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2Key(pass, salt);
  const priv = await decryptWith(key, w.enc);
  unlockedKeys.set(id, priv);
  return { address: w.address };
}

export function lockWallet(id: string): void { unlockedKeys.delete(id); }

export async function grantWallet(id: string, agentId: string, allow: boolean): Promise<{ ok: boolean; allowedAgents: string[] }> {
  const list = await loadWallets();
  const w = list.find((x) => x.id === id);
  if (!w) throw new Error('钱包不存在');
  const set = new Set(w.allowedAgents || []);
  if (allow) set.add(agentId); else set.delete(agentId);
  w.allowedAgents = Array.from(set);
  await saveWallets(list);
  return { ok: true, allowedAgents: w.allowedAgents };
}

/** 某本地智能体可调用的钱包 (仅其被授予的) — agent 工具使用 */
export async function walletForAgent(agentId: string): Promise<{ exists: boolean; agentId: string; wallets: Array<{ id: string; name: string; address: string; unlocked: boolean }>; error?: string }> {
  const list = await loadWallets();
  const mine = list.filter((w) => (w.allowedAgents || []).includes(agentId));
  return {
    exists: mine.length > 0,
    agentId,
    wallets: mine.map((w) => ({ id: w.id, name: w.name, address: w.address, unlocked: unlockedKeys.has(w.id) })),
  };
}

export async function walletBalance(id?: string, rpcUrl?: string): Promise<string> {
  const list = await loadWallets();
  let w: WalletRecord | undefined;
  if (id) w = list.find((x) => x.id === id);
  else w = list.filter((x) => unlockedKeys.has(x.id))[0] || list[0];
  if (!w) throw new Error('钱包未创建');
  const res = await fetch(rpcUrl || DEFAULT_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [w.address, 'latest'] }),
  });
  const j = await res.json();
  const wei = BigInt(j && j.result ? String(j.result) : '0x0');
  return (Number(wei) / 1e18).toFixed(6) + ' ETH';
}
