/**
 * human-directory.ts — 手机号 → DID 人类账号目录 (2026-10-11, phone-account-lookup-design §3)
 *
 * 落点 A (群内/已知盐目录, 推荐起步):
 *   - 发布: 用户 opt-in → 本地算 HMAC(salt || phone, pepper) 盲化哈希 → 存目录条目
 *   - 查询: 输入对方手机号 → 用同一算法算哈希 → 遍历本地目录比对 → 命中拿 DID
 *   - 隐私: 目录永不存明文手机号 · 哈希带 per-user salt (不可离线枚举) ·
 *           pepper 本地持有不进目录 · 未发布 = 查不到 (与不存在同义)
 *
 * 诚实边界 (写死):
 *   - 落点 A 只能搜「已与你交换过 salt / 已加入同一群」的节点 (三角不可能: 隐私/可搜/去中心化只取二)
 *   - 本模块只做「本地目录 + 哈希运算」; 跨节点查询靠既有 P2P (群目录复制 / direct 消息)
 *   - pepper 是本机私密 (~/.bolloon/contacts/directory-pepper.json, 0600), 不进目录条目
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHmac, randomBytes } from 'node:crypto';

export interface DirectoryEntry {
  phoneHash: string;        // HMAC-SHA256(salt || phone, pepper) → hex
  salt: string;             // per-user salt (发布时生成, 使哈希不可离线枚举)
  did: string;              // 目标 DID (did:key:...)
  displayName?: string;     // 可选昵称 (用户自己填, 不是真名)
  publishedAt: string;
  revokedAt?: string | null; // 撤销指针 (软删)
  ownerSig: string;         // 用户私钥签名 (防目录伪造条目) — P2 落点 B 用, A 阶段可为空串
}

export interface DirectoryLookupResult {
  found: boolean;
  did?: string;
  displayName?: string;
  revoked?: boolean;
}

const home = () => process.env.HOME || os.homedir() || '/tmp';

export function directoryPath(homeDir?: string): string {
  return path.join(homeDir || home(), '.bolloon', 'contacts', 'human-directory.json');
}

/** pepper 路径 (0600 私密) */
export function pepperPath(homeDir?: string): string {
  return path.join(homeDir || home(), '.bolloon', 'contacts', 'directory-pepper.json');
}

/** 原子写: tmp + rename (写坏不残留半截文件; 0600 私密权限) */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

/** 读取/生成 pepper (首次生成随机 32 字节; 幂等复用) */
export async function loadPepper(homeDir?: string): Promise<string> {
  const p = pepperPath(homeDir);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    if (j?.pepper) return j.pepper;
  } catch { /* 不存在 → 生成 */ }
  const pepper = randomBytes(32).toString('hex');
  await atomicWriteJson(p, { pepper });
  return pepper;
}

/** 手机号归一化: 只留数字与 + (同一规则只此一处, 供校验与哈希共用) */
export function normalizePhone(value: string): string {
  return String(value || '').replace(/[^\d+]/g, '');
}

/** 盲化哈希: HMAC-SHA256(salt || phone, pepper) → hex (同一输入永远同一输出) */
export function blindHash(phone: string, salt: string, pepper: string): string {
  const normalized = normalizePhone(phone);
  return createHmac('sha256', pepper).update(`${salt}||${normalized}`).digest('hex');
}

/** 生成 per-user salt */
export function genSalt(): string {
  return randomBytes(16).toString('hex');
}

/** 校验手机号形状 (宽松: 8-15 位数字, 可带 + 前缀) */
export function isPlausiblePhone(value: string): boolean {
  return /^\+?\d{8,15}$/.test(normalizePhone(value));
}

/** 目录存储: 读/写原子 (与 contacts store 同模式) */
export async function readDirectory(homeDir?: string): Promise<DirectoryEntry[]> {
  try {
    const raw = await fs.readFile(directoryPath(homeDir), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`手机号目录损坏 (${directoryPath(homeDir)}): ${err?.message || err}`);
  }
}

async function writeDirectory(entries: DirectoryEntry[], homeDir?: string): Promise<void> {
  await atomicWriteJson(directoryPath(homeDir), entries);
}

/** 发布一条目录条目 (opt-in; 同 phoneHash 已存在 → 更新为最新, 撤销后重发 = 恢复) */
export async function publishEntry(
  phone: string,
  did: string,
  opts: { displayName?: string; homeDir?: string } = {},
): Promise<DirectoryEntry> {
  if (!isPlausiblePhone(phone)) throw new Error('手机号格式不正确 (8-15 位数字, 可带 + 前缀)');
  if (!did || !did.startsWith('did:')) throw new Error('DID 格式不正确 (须以 did: 开头)');
  const pepper = await loadPepper(opts.homeDir);
  const salt = genSalt(); // 每次发布新 salt (旧哈希不可回推, 重发布 = 新哈希)
  const entry: DirectoryEntry = {
    phoneHash: blindHash(phone, salt, pepper),
    salt,
    did,
    displayName: opts.displayName,
    publishedAt: new Date().toISOString(),
    revokedAt: null,
    ownerSig: '', // P2 落点 B 才要求签名
  };
  const entries = await readDirectory(opts.homeDir);
  const idx = entries.findIndex((e) => e.did === did); // 同一 DID 只留一条 (更新)
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  await writeDirectory(entries, opts.homeDir);
  return entry;
}

/** 撤销 (软删): 标记 revokedAt, 条目保留 (审计/可恢复) */
export async function retractEntry(did: string, homeDir?: string): Promise<boolean> {
  const entries = await readDirectory(homeDir);
  const e = entries.find((x) => x.did === did);
  if (!e) return false;
  e.revokedAt = new Date().toISOString();
  await writeDirectory(entries, homeDir);
  return true;
}

/** 查询: 用同一算法算哈希, 遍历比对 (未发布/已撤销 → not found) */
export async function lookupPhone(
  phone: string,
  homeDir?: string,
): Promise<DirectoryLookupResult> {
  const pepper = await loadPepper(homeDir);
  const entries = await readDirectory(homeDir);
  // 对方的 salt 未知 → 逐个试本目录里的条目 salt (落点 A: 群小, N 可接受)
  for (const e of entries) {
    if (blindHash(phone, e.salt, pepper) === e.phoneHash) {
      if (e.revokedAt) return { found: false, revoked: true }; // 撤销 = 与不存在同义
      return { found: true, did: e.did, displayName: e.displayName };
    }
  }
  return { found: false };
}

/** 列出已发布条目 (本机审计用; 只回脱敏: 哈希前 8 位 + DID + 时间) */
export function summarizeEntries(entries: DirectoryEntry[]): Array<{ hash: string; did: string; publishedAt: string; revoked: boolean }> {
  return entries.map((e) => ({
    hash: e.phoneHash.slice(0, 8) + '…',
    did: e.did,
    publishedAt: e.publishedAt,
    revoked: !!e.revokedAt,
  }));
}
